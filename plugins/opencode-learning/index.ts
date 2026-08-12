// learning/src/index.js
import fs3 from "node:fs/promises";
import path6 from "node:path";
import { Plugin } from "@opencode-ai/plugin";

// learning/src/config.js
import os from "node:os";
import path from "node:path";
var DEFAULTS = Object.freeze({
  enabled: true,
  mode: "suggest",
  // off | suggest | auto
  scoreThreshold: 10,
  reviewerTimeoutMs: 12e4,
  maxEventsPerSession: 120,
  maxCandidates: 5,
  confidenceThreshold: 0.72,
  agentValidation: true,
  notify: true,
  reflectorAgent: "learning-reflector",
  validatorAgent: "learning-validator",
  projectSkillDir: ".opencode/skills",
  globalSkillDir: path.join(os.homedir(), ".config/opencode/skills"),
  stateDir: ".opencode/.learning",
  curator: {
    enabled: true,
    checkEveryHours: 24,
    staleAfterDays: 30,
    archiveAfterDays: 90
  }
});
function loadConfig(options = {}) {
  const mode = ["off", "suggest", "auto"].includes(options.mode) ? options.mode : DEFAULTS.mode;
  const curator = {
    ...DEFAULTS.curator,
    ...options.curator && typeof options.curator === "object" ? options.curator : {}
  };
  return {
    ...DEFAULTS,
    ...options,
    mode,
    curator,
    enabled: options.enabled !== false && mode !== "off",
    agentValidation: options.agentValidation !== false,
    notify: options.notify !== false
  };
}

// learning/src/util.js
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path2 from "node:path";
function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function safeId(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64;
}
function canonicalSkillId(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKD").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
}
function normalizeCreateProposal(proposal) {
  if (proposal?.decision !== "create") return proposal;
  const skillId = canonicalSkillId(proposal.skillId) || canonicalSkillId(proposal.skill?.name);
  return { ...proposal, skillId };
}
async function atomicWrite(file, text) {
  await fs.mkdir(path2.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(temp, text, { encoding: "utf8", mode: 384 });
  await fs.rename(temp, file);
}
async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}
async function writeJson(file, value) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}
`);
}
function trimText(value, max = 4e3) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}
\u2026[truncated ${text.length - max} chars]`;
}
function extractText(value, depth = 0) {
  if (depth > 8 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((x) => extractText(x, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  for (const key of ["text", "content", "message", "output"]) {
    if (key in value) {
      const text = extractText(value[key], depth + 1);
      if (text) return text;
    }
  }
  return "";
}
function messageRole(message) {
  if (!message || typeof message !== "object") return void 0;
  return message.role ?? message.type ?? message.kind;
}
function daysSince(epochMs, now = Date.now()) {
  return (now - epochMs) / 864e5;
}
function redactError(error) {
  if (!error) return "unknown error";
  return trimText(error?.message ?? error, 800);
}

// learning/src/recorder.js
var CORRECTION_RE = /\b(no|don't|do not|instead|actually|never|must|wrong|correction|not that|shouldn't|should not)\b/i;
var VERIFY_RE = /\b(test|tests|verify|verification|check|lint|typecheck|type-check|build|compile|smoke)\b/i;
var ExperienceRecorder = class {
  constructor({ maxEventsPerSession = 120 } = {}) {
    this.maxEventsPerSession = maxEventsPerSession;
    this.sessions = /* @__PURE__ */ new Map();
    this.pendingTools = /* @__PURE__ */ new Map();
  }
  get(sessionID) {
    if (!this.sessions.has(sessionID)) {
      this.sessions.set(sessionID, {
        sessionID,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        goal: "",
        contextTail: [],
        corrections: [],
        seenUserMessages: /* @__PURE__ */ new Set(),
        toolCalls: [],
        skillsUsed: /* @__PURE__ */ new Set(),
        recoveries: 0,
        verificationSteps: 0
      });
    }
    return this.sessions.get(sessionID);
  }
  observeContext(event) {
    const sessionID = event?.sessionID;
    if (!sessionID) return void 0;
    const exp = this.get(sessionID);
    exp.updatedAt = Date.now();
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const tail = messages.slice(-8).map((m) => ({ role: messageRole(m), text: trimText(extractText(m), 1800) })).filter((x) => x.text);
    exp.contextTail = tail;
    const users = tail.filter((x) => x.role === "user");
    if (!exp.goal && users.length) exp.goal = users.at(-1).text;
    for (const item of users) {
      const fingerprint = item.text.slice(0, 1200);
      if (exp.seenUserMessages.has(fingerprint)) continue;
      exp.seenUserMessages.add(fingerprint);
      if (CORRECTION_RE.test(item.text)) exp.corrections.push(item.text);
    }
    exp.corrections = exp.corrections.slice(-12);
    return exp;
  }
  toolBefore(event) {
    if (!event?.sessionID || !event?.tool) return;
    const callID = event.id;
    const key = `${event.sessionID}:${callID}`;
    this.pendingTools.set(key, {
      sessionID: event.sessionID,
      callID,
      tool: event.tool,
      input: trimText(event.input, 2500),
      startedAt: Date.now()
    });
  }
  toolAfter(event) {
    if (!event?.sessionID || !event?.tool) return void 0;
    const exp = this.get(event.sessionID);
    const callID = event.id;
    const key = `${event.sessionID}:${callID}`;
    const pending = this.pendingTools.get(key);
    if (pending) this.pendingTools.delete(key);
    const failed = event.status === "error" || Boolean(event.error);
    const input = pending?.input ?? trimText(event.input, 2500);
    const record = {
      tool: event.tool,
      input,
      status: failed ? "error" : "success",
      result: trimText(failed ? event.error : event.result, 3e3),
      durationMs: pending ? Date.now() - pending.startedAt : void 0,
      at: Date.now()
    };
    exp.toolCalls.push(record);
    if (exp.toolCalls.length > this.maxEventsPerSession) exp.toolCalls.shift();
    exp.updatedAt = Date.now();
    if (event.tool === "skill") {
      const raw = typeof event.input === "object" ? event.input?.name ?? event.input?.id ?? event.input?.skill : void 0;
      if (typeof raw === "string") exp.skillsUsed.add(raw);
    }
    const prev = exp.toolCalls.at(-2);
    if (prev?.status === "error" && record.status === "success" && prev.tool === record.tool) exp.recoveries += 1;
    if (VERIFY_RE.test(`${event.tool} ${input}`)) exp.verificationSteps += 1;
    return exp;
  }
  snapshot(sessionID) {
    const exp = this.sessions.get(sessionID);
    if (!exp) return void 0;
    return {
      ...exp,
      skillsUsed: [...exp.skillsUsed],
      seenUserMessages: void 0,
      toolCalls: exp.toolCalls.map((x) => ({ ...x })),
      corrections: [...exp.corrections],
      contextTail: exp.contextTail.map((x) => ({ ...x }))
    };
  }
  clear(sessionID) {
    this.sessions.delete(sessionID);
  }
};
// learning/src/skill-store.js
import fs2 from "node:fs/promises";
import path3 from "node:path";
import { randomUUID } from "node:crypto";

// learning/src/proposal.js
var SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*[^\s]{8,}/i
];
var TRANSIENT_PATTERNS = [
  /\/tmp\//,
  /\/var\/tmp\//,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\b20\d\d[-/]\d\d[-/]\d\d[T ]\d\d:/,
  /\bpid\s*[=:]?\s*\d{2,}\b/i
];
function validateProposal(proposal, { confidenceThreshold = 0.72 } = {}) {
  const errors = [];
  const warnings = [];
  if (!proposal || typeof proposal !== "object") return { ok: false, errors: ["proposal must be an object"], warnings };
  if (!["none", "create", "patch"].includes(proposal.decision)) errors.push("decision must be none, create, or patch");
  if (typeof proposal.reason !== "string" || proposal.reason.trim().length < 12) errors.push("reason is required");
  if (!Array.isArray(proposal.evidence)) errors.push("evidence must be an array");
  if (typeof proposal.confidence !== "number" || proposal.confidence < 0 || proposal.confidence > 1) errors.push("confidence must be 0..1");
  if (proposal.decision === "none") return { ok: errors.length === 0, errors, warnings };
  if (!safeId(proposal.skillId ?? "")) errors.push("skillId must be lowercase kebab-case, 1-64 chars");
  if (!Array.isArray(proposal.evidence) || proposal.evidence.length === 0) errors.push("at least one evidence item is required");
  if (proposal.confidence < confidenceThreshold) errors.push(`confidence below threshold ${confidenceThreshold}`);
  if (proposal.scope && !["project", "global"].includes(proposal.scope)) errors.push("scope must be project or global");
  if (proposal.scope === "global") errors.push("global skill writes are disabled");
  const serialized = JSON.stringify(proposal);
  if (SECRET_PATTERNS.some((re) => re.test(serialized))) errors.push("proposal appears to contain a credential or secret");
  if (TRANSIENT_PATTERNS.some((re) => re.test(serialized))) warnings.push("proposal contains machine- or run-specific data; inspect before applying");
  if (proposal.decision === "create") {
    if (!proposal.skill || typeof proposal.skill !== "object") errors.push("create requires skill");
    else {
      if (typeof proposal.skill.name !== "string" || !proposal.skill.name.trim()) errors.push("skill.name is required");
      if (typeof proposal.skill.description !== "string" || proposal.skill.description.trim().length < 12) errors.push("skill.description is required");
      if (typeof proposal.skill.body !== "string" || proposal.skill.body.trim().length < 40) errors.push("skill.body is too short");
      validateSupportingFiles(proposal.skill.files, errors, "skill.files");
    }
  }
  if (proposal.decision === "patch") {
    if (typeof proposal.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(proposal.expectedSha256)) errors.push("patch requires expectedSha256");
    if (!Array.isArray(proposal.operations) || proposal.operations.length === 0) errors.push("patch requires operations");
    for (const op of proposal.operations ?? []) {
      if (!["replace_section", "append_section"].includes(op.kind)) errors.push(`unsupported operation ${op.kind}`);
      if (typeof op.heading !== "string" || !op.heading.trim()) errors.push("operation heading is required");
      if (typeof op.body !== "string" || !op.body.trim()) errors.push("operation body is required");
    }
    validateSupportingFiles(proposal.addFiles, errors, "addFiles");
  }
  return { ok: errors.length === 0, errors, warnings };
}
function validateSupportingFiles(files, errors, label) {
  if (files == null) return;
  if (!Array.isArray(files)) {
    errors.push(`${label} must be an array`);
    return;
  }
  for (const file of files) {
    if (!file || typeof file !== "object") {
      errors.push(`${label} entries must be objects`);
      continue;
    }
    if (!safeSupportPath(file.path)) errors.push(`${label} path must be a safe relative path outside SKILL.md`);
    if (typeof file.content !== "string" || !file.content.trim()) errors.push(`${label} content is required`);
  }
}
function safeSupportPath(value) {
  if (typeof value !== "string" || !value || value.length > 180) return false;
  if (value === "SKILL.md" || value.startsWith("/") || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== ".." && !part.startsWith("."));
}
var proposalInputSchema = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["none", "create", "patch"] },
    skillId: { type: "string", description: "Lowercase kebab-case skill ID, 1-64 characters. Required for create and patch decisions." },
    scope: { type: "string", enum: ["project", "global"] },
    reason: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "array", items: { type: "string" } },
    expectedSha256: { type: "string" },
    skill: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        body: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["replace_section", "append_section"] },
          heading: { type: "string" },
          body: { type: "string" }
        },
        required: ["kind", "heading", "body"],
        additionalProperties: false
      }
    },
    addFiles: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false
      }
    }
  },
  required: ["decision", "reason", "confidence", "evidence"],
  additionalProperties: false
};
var validationInputSchema = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["accept", "reject"] },
    reason: { type: "string" },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["decision", "reason", "warnings"],
  additionalProperties: false
};

// learning/src/skill-store.js
var OWNER_MARKER = 'learning/owner: "opencode-learning"';
var SkillStore = class {
  constructor({ projectRoot, projectSkillDir, globalSkillDir, stateDir }) {
    this.projectRoot = projectRoot;
    this.projectRootSkills = path3.resolve(projectRoot, projectSkillDir);
    this.globalRootSkills = path3.resolve(globalSkillDir);
    this.stateRoot = path3.resolve(projectRoot, stateDir);
    this.pendingRoot = path3.join(this.stateRoot, "pending");
    this.archiveRoot = path3.join(this.stateRoot, "archive");
  }
  root(scope = "project") {
    return scope === "global" ? this.globalRootSkills : this.projectRootSkills;
  }
  skillDir(skillId, scope = "project") {
    if (!safeId(skillId)) throw new Error(`invalid skill id: ${skillId}`);
    return path3.join(this.root(scope), skillId);
  }
  skillPath(skillId, scope = "project") {
    return path3.join(this.skillDir(skillId, scope), "SKILL.md");
  }
  async getOwned(skillId, scope = "project") {
    const file = this.skillPath(skillId, scope);
    try {
      const text = await fs2.readFile(file, "utf8");
      if (!text.includes(OWNER_MARKER)) return void 0;
      return {
        skillId,
        scope,
        file,
        dir: path3.dirname(file),
        text,
        sha256: sha256(text),
        supportingFiles: await this.listSupportingFiles(skillId, scope)
      };
    } catch (error) {
      if (error?.code === "ENOENT") return void 0;
      throw error;
    }
  }
  async listSupportingFiles(skillId, scope = "project") {
    const root = this.skillDir(skillId, scope);
    const out = [];
    await walk(root, root, out);
    return out.filter((item) => item.path !== "SKILL.md").slice(0, 100);
  }
  async listOwned(scope = "project") {
    const root = this.root(scope);
    let dirs;
    try {
      dirs = await fs2.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const out = [];
    for (const entry of dirs) {
      if (!entry.isDirectory() || !safeId(entry.name)) continue;
      const item = await this.getOwned(entry.name, scope);
      if (item) out.push(item);
    }
    return out;
  }
  renderCreated(proposal) {
    const { skill } = proposal;
    return `---
name: ${yamlScalar(skill.name)}
description: ${yamlScalar(skill.description)}
metadata:
  opencode/slash: "false"
  opencode/autoinvoke: "true"
  ${OWNER_MARKER}
  learning/created: ${yamlScalar(nowIso())}
  learning/version: "1"
---

${skill.body.trim()}
`;
  }
  async create(proposal, { scope = "project" } = {}) {
    const dir = this.skillDir(proposal.skillId, scope);
    const file = path3.join(dir, "SKILL.md");
    try {
      await fs2.access(file);
      throw new Error(`skill already exists: ${proposal.skillId}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const text = this.renderCreated(proposal);
    await atomicWrite(file, text);
    try {
      await this.addSupportingFiles(dir, proposal.skill?.files ?? []);
    } catch (error) {
      await fs2.rm(dir, { recursive: true, force: true });
      throw error;
    }
    return { file, text, sha256: sha256(text), supportingFiles: proposal.skill?.files?.map((x) => x.path) ?? [] };
  }
  async patch(proposal, { scope = "project" } = {}) {
    const current = await this.getOwned(proposal.skillId, scope);
    if (!current) throw new Error(`refusing to patch non-owned or missing skill: ${proposal.skillId}`);
    if (current.sha256 !== proposal.expectedSha256) throw new Error(`stale patch for ${proposal.skillId}; skill changed since reflection`);
    for (const item of proposal.addFiles ?? []) {
      const target = supportPath(current.dir, item.path);
      try {
        await fs2.access(target);
        throw new Error(`refusing to overwrite existing supporting file: ${item.path}`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    let text = current.text;
    for (const op of proposal.operations ?? []) text = applySectionOperation(text, op);
    text = bumpVersion(text);
    await atomicWrite(current.file, text);
    await this.addSupportingFiles(current.dir, proposal.addFiles ?? []);
    return { file: current.file, text, sha256: sha256(text), addedFiles: proposal.addFiles?.map((x) => x.path) ?? [] };
  }
  async addSupportingFiles(skillDir, files) {
    for (const item of files) {
      const target = supportPath(skillDir, item.path);
      await atomicWrite(target, item.content);
    }
  }
  async stage(proposal, validation) {
    const id = `${Date.now()}-${randomUUID()}-${proposal.skillId ?? "none"}`;
    const dir = path3.join(this.pendingRoot, id);
    await fs2.mkdir(dir, { recursive: true });
    await atomicWrite(path3.join(dir, "proposal.json"), `${JSON.stringify({ proposal, validation }, null, 2)}
`);
    if (proposal.decision === "create") {
      await atomicWrite(path3.join(dir, "SKILL.preview.md"), this.renderCreated(proposal));
      for (const file of proposal.skill?.files ?? []) {
        await atomicWrite(path3.join(dir, "FILES", file.path), file.content);
      }
    } else if (proposal.decision === "patch") {
      const current = await this.getOwned(proposal.skillId, proposal.scope ?? "project");
      if (current) {
        let next = current.text;
        for (const op of proposal.operations ?? []) next = applySectionOperation(next, op);
        next = bumpVersion(next);
        await atomicWrite(path3.join(dir, "BEFORE.md"), current.text);
        await atomicWrite(path3.join(dir, "AFTER.md"), next);
        for (const file of proposal.addFiles ?? []) {
          await atomicWrite(path3.join(dir, "FILES", file.path), file.content);
        }
      }
    }
    return { id, dir };
  }
  async listPending() {
    let entries;
    try {
      entries = await fs2.readdir(this.pendingRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = JSON.parse(await fs2.readFile(path3.join(this.pendingRoot, entry.name, "proposal.json"), "utf8"));
        out.push({ id: entry.name, ...raw });
      } catch {
      }
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }
  async getPending(id) {
    const dir = safePending(this.pendingRoot, id);
    const raw = JSON.parse(await fs2.readFile(path3.join(dir, "proposal.json"), "utf8"));
    const result2 = { id, ...raw, previews: {} };
    for (const name of ["SKILL.preview.md", "BEFORE.md", "AFTER.md"]) {
      try {
        result2.previews[name] = await fs2.readFile(path3.join(dir, name), "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return result2;
  }
  async applyPending(id) {
    const dir = safePending(this.pendingRoot, id);
    const raw = JSON.parse(await fs2.readFile(path3.join(dir, "proposal.json"), "utf8"));
    const proposal = raw.proposal;
    let result2;
    if (proposal.decision === "create") result2 = await this.create(proposal, { scope: proposal.scope ?? "project" });
    else if (proposal.decision === "patch") result2 = await this.patch(proposal, { scope: proposal.scope ?? "project" });
    else result2 = { skipped: true };
    await fs2.rm(dir, { recursive: true, force: true });
    return { result: result2, proposal };
  }
  async rejectPending(id) {
    const dir = safePending(this.pendingRoot, id);
    await fs2.rm(dir, { recursive: true, force: true });
  }
  async promote(skillId) {
    const source = await this.getOwned(skillId, "project");
    if (!source) throw new Error(`cannot promote non-owned or missing project skill: ${skillId}`);
    if (await this.getOwned(skillId, "global")) throw new Error(`global skill already exists: ${skillId}`);
    const target = this.skillDir(skillId, "global");
    try {
      await fs2.access(target);
      throw new Error(`global skill path already exists: ${skillId}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs2.mkdir(this.globalRootSkills, { recursive: true });
    let reserved = false;
    try {
      await fs2.mkdir(target);
      reserved = true;
      for (const entry of await fs2.readdir(source.dir)) {
        await fs2.cp(path3.join(source.dir, entry), path3.join(target, entry), {
          recursive: true,
          force: false,
          errorOnExist: true
        });
      }
    } catch (error) {
      if (reserved) await fs2.rm(target, { recursive: true, force: true });
      throw error;
    }
    return { skillId, source: source.dir, target };
  }
  async archive(skillId, { scope = "project" } = {}) {
    const current = await this.getOwned(skillId, scope);
    if (!current) return false;
    const target = path3.join(this.archiveRoot, scope, `${Date.now()}-${skillId}`);
    await fs2.mkdir(path3.dirname(target), { recursive: true });
    await fs2.rename(current.dir, target);
    return true;
  }
};
function applySectionOperation(markdown, op) {
  const heading = op.heading.trim().replace(/^#+\s*/, "");
  const section = `## ${heading}

${op.body.trim()}
`;
  const re = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "mi");
  const match = re.exec(markdown);
  if (op.kind === "append_section" || !match) return `${markdown.trimEnd()}

${section}`;
  const start = match.index;
  const afterHeading = start + match[0].length;
  const rest = markdown.slice(afterHeading);
  const next = /^##\s+.+$/m.exec(rest);
  const end = next ? afterHeading + next.index : markdown.length;
  return `${markdown.slice(0, start)}${section}
${markdown.slice(end).replace(/^\s+/, "")}`;
}
function bumpVersion(text) {
  const version = /learning\/version:\s*["']?(\d+)["']?/.exec(text);
  if (!version) return text;
  const next = Number(version[1]) + 1;
  return text.replace(version[0], `learning/version: "${next}"`);
}
function yamlScalar(value) {
  return JSON.stringify(String(value));
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function safePending(root, id) {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("invalid pending id");
  const dir = path3.join(root, id);
  if (!dir.startsWith(root + path3.sep)) throw new Error("invalid pending path");
  return dir;
}
function supportPath(skillDir, relative) {
  if (!safeSupportPath(relative)) throw new Error(`invalid supporting file path: ${relative}`);
  const target = path3.resolve(skillDir, relative);
  if (!target.startsWith(path3.resolve(skillDir) + path3.sep)) throw new Error(`supporting file escapes skill directory: ${relative}`);
  return target;
}
async function walk(root, current, out) {
  let entries;
  try {
    entries = await fs2.readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const full = path3.join(current, entry.name);
    if (entry.isDirectory()) await walk(root, full, out);
    else if (entry.isFile()) {
      const stat = await fs2.stat(full);
      out.push({ path: path3.relative(root, full).split(path3.sep).join("/"), bytes: stat.size });
    }
  }
}

// learning/src/telemetry.js
import path4 from "node:path";
var Telemetry = class {
  constructor(stateRoot) {
    this.file = path4.join(stateRoot, "telemetry.json");
    this.state = { version: 2, skills: {}, reviews: [] };
    this.queue = Promise.resolve();
  }
  async load() {
    this.state = await readJson(this.file, this.state);
    this.state.version = 2;
    this.state.skills ??= {};
    this.state.reviews ??= [];
    return this;
  }
  skill(id) {
    return this.state.skills[id] ??= {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      uses: 0,
      observedSessions: 0,
      sessionsWithErrors: 0,
      sessionsWithRecovery: 0,
      sessionsWithCorrections: 0,
      patches: 0,
      state: "active",
      owner: "opencode-learning",
      seenSessions: []
    };
  }
  recordUse(id) {
    const s = this.skill(id);
    s.uses += 1;
    s.updatedAt = Date.now();
    return this.flush();
  }
  recordExperience(exp) {
    const failures = exp.toolCalls?.some((x) => x.status === "error") ?? false;
    for (const id of exp.skillsUsed ?? []) {
      const s = this.skill(id);
      s.seenSessions ??= [];
      if (s.seenSessions.includes(exp.sessionID)) continue;
      s.seenSessions.push(exp.sessionID);
      s.seenSessions = s.seenSessions.slice(-100);
      s.observedSessions += 1;
      if (failures) s.sessionsWithErrors += 1;
      if ((exp.recoveries ?? 0) > 0) s.sessionsWithRecovery += 1;
      if ((exp.corrections?.length ?? 0) > 0) s.sessionsWithCorrections += 1;
      s.updatedAt = Date.now();
    }
    return this.flush();
  }
  recordCreated(id) {
    const s = this.skill(id);
    s.createdAt = Date.now();
    s.updatedAt = Date.now();
    return this.flush();
  }
  recordPatched(id) {
    const s = this.skill(id);
    s.patches += 1;
    s.updatedAt = Date.now();
    return this.flush();
  }
  recordReview(item) {
    this.state.reviews.push({ ...item, at: Date.now() });
    this.state.reviews = this.state.reviews.slice(-200);
    return this.flush();
  }
  recentReviews(limit = 10) {
    return this.state.reviews.slice(-limit).reverse();
  }
  async flush() {
    this.queue = this.queue.then(() => writeJson(this.file, this.state));
    return this.queue;
  }
};

// learning/src/mailbox.js
var InternalMailbox = class {
  constructor() {
    this.internal = /* @__PURE__ */ new Map();
    this.waiters = /* @__PURE__ */ new Map();
    this.early = /* @__PURE__ */ new Map();
    this.submitted = /* @__PURE__ */ new Set();
  }
  register(sessionID, kind) {
    this.internal.set(sessionID, kind);
  }
  release(sessionID) {
    this.internal.delete(sessionID);
    this.waiters.get(sessionID)?.cancel();
    this.waiters.delete(sessionID);
    this.early.delete(sessionID);
    this.submitted.delete(sessionID);
  }
  isInternalSession(sessionID) {
    return this.internal.has(sessionID);
  }
  kind(sessionID) {
    return this.internal.get(sessionID);
  }
  sessionIDs() {
    return [...this.internal.keys()];
  }
  hasSubmitted(sessionID) {
    return this.submitted.has(sessionID);
  }
  submit(sessionID, kind, payload) {
    if (this.internal.get(sessionID) !== kind) throw new Error(`session is not registered for ${kind}`);
    this.submitted.add(sessionID);
    const waiter = this.waiters.get(sessionID);
    if (waiter) {
      this.waiters.delete(sessionID);
      waiter.resolve(payload);
    } else if (!this.early.has(sessionID)) {
      this.early.set(sessionID, payload);
    } else {
      throw new Error(`session ${sessionID} already submitted ${kind}`);
    }
  }
  wait(sessionID, timeoutMs) {
    if (!this.internal.has(sessionID)) throw new Error(`internal session ${sessionID} is not registered`);
    if (this.early.has(sessionID)) {
      const payload = this.early.get(sessionID);
      this.early.delete(sessionID);
      return Promise.resolve(payload);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(sessionID);
        reject(new Error(`internal agent did not submit within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(sessionID, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        cancel: () => clearTimeout(timer)
      });
    });
  }
};

// learning/src/event-bus.js
var TERMINAL_EVENTS = /* @__PURE__ */ new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted"
]);
var EventBus = class {
  constructor(ctx) {
    this.ctx = ctx;
    this.listeners = /* @__PURE__ */ new Set();
    this.controller = void 0;
    this.task = void 0;
    this.disposed = false;
  }
  start() {
    if (this.task || this.disposed) return;
    this.controller = new AbortController();
    this.task = this._run();
  }
  onTerminal(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async _run() {
    while (!this.disposed) {
      try {
        const stream = this.ctx.event.subscribe({ signal: this.controller.signal });
        for await (const event of stream) {
          if (this.disposed) break;
          if (!TERMINAL_EVENTS.has(event.type)) continue;
          const sessionID = event.data?.sessionID;
          if (!sessionID) continue;
          for (const listener of this.listeners) {
            try {
              listener({ ...event, sessionID });
            } catch (error) {
              console.error("[opencode-learning] terminal event listener failed", error);
            }
          }
        }
      } catch (error) {
        if (this.disposed || this.controller?.signal.aborted) break;
        console.error("[opencode-learning] event stream failed", error);
      }
      if (!this.disposed) await delay(1e3, this.controller.signal);
    }
    this.task = void 0;
  }
  async dispose() {
    this.disposed = true;
    this.controller?.abort();
    await this.task;
  }
};
function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// learning/src/opencode-adapter.js
var OpenCodeAdapter = class {
  constructor(ctx) {
    this.ctx = ctx;
    this.events = new EventBus(ctx);
  }
  start() {
    this.events.start();
  }
  onExecutionTerminal(listener) {
    return this.events.onTerminal(listener);
  }
  async createInternalSession({ directory, agent, title, model }) {
    const input = { title, agent, location: { directory } };
    if (model?.id && model?.providerID) input.model = model;
    return this.ctx.session.create(input);
  }
  async prompt(sessionID, text) {
    return this.ctx.session.prompt({ sessionID, text, delivery: "queue", resume: true });
  }
  async getSession(sessionID) {
    return this.ctx.session.get({ sessionID });
  }
  async interrupt(sessionID) {
    if (typeof this.ctx.session.interrupt !== "function") return;
    try {
      await this.ctx.session.interrupt({ sessionID });
    } catch {
    }
  }
  async notify(sessionID, text) {
    if (typeof this.ctx.session.synthetic !== "function") return;
    try {
      await this.ctx.session.synthetic({
        sessionID,
        text,
        description: "opencode-learning",
        metadata: { source: "opencode-learning" },
        delivery: "queue",
        resume: false
      });
    } catch {
    }
  }
  async reloadSkills() {
    return this.ctx.skill.reload();
  }
  async listSkills() {
    return (await this.ctx.skill.list()).data;
  }
  async dispose() {
    await this.events.dispose();
  }
};

// learning/src/scoring.js
function scoreExperience(exp) {
  const tools = exp.toolCalls?.length ?? 0;
  const failed = exp.toolCalls?.filter((x) => x.status === "error").length ?? 0;
  const recovered = exp.recoveries ?? 0;
  const corrections = exp.corrections?.length ?? 0;
  const skills = exp.skillsUsed?.size ?? exp.skillsUsed?.length ?? 0;
  const verification = exp.verificationSteps ?? 0;
  return {
    score: tools + failed * 3 + recovered * 5 + corrections * 8 + skills * 2 + verification * 2,
    reasons: { tools, failed, recovered, corrections, skills, verification }
  };
}
function isReviewCandidate(exp, threshold) {
  return scoreExperience(exp).score >= threshold;
}

// learning/src/retriever.js
function tokens(text) {
  return new Set(String(text).toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? []);
}
function overlapScore(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let hits = 0;
  for (const item of A) if (B.has(item)) hits++;
  return hits / Math.sqrt(A.size * B.size);
}
async function retrieveCandidates({ exp, adapter, store, maxCandidates = 5 }) {
  let catalog = [];
  try {
    catalog = await adapter.listSkills() ?? [];
  } catch {
  }
  if (!Array.isArray(catalog)) catalog = catalog?.skills ?? [];
  const query = [
    exp.goal,
    ...(exp.contextTail ?? []).map((x) => x.text ?? x),
    ...(exp.toolCalls ?? []).slice(-16).map((x) => `${x.tool} ${x.input} ${x.result}`)
  ].join("\n");
  const used = new Set(exp.skillsUsed ?? []);
  const ranked = catalog.map((skill) => {
    const id = skill.id ?? skill.skillID ?? skill.name ?? "";
    const description = skill.description ?? "";
    return {
      id,
      name: skill.name ?? id,
      description,
      score: overlapScore(query, `${id} ${description}`) + (used.has(id) ? 1 : 0)
    };
  }).filter((x) => x.id).sort((a, b) => b.score - a.score).slice(0, maxCandidates);
  for (const item of ranked) {
    const owned = await store.getOwned(item.id, "project");
    if (owned) {
      item.owned = true;
      item.scope = owned.scope;
      item.sha256 = owned.sha256;
      item.body = owned.text;
      item.supportingFiles = owned.supportingFiles;
    } else {
      item.owned = false;
    }
  }
  return ranked;
}

// learning/src/reviewer.js
function trajectoryPayload(exp) {
  return {
    goal: trimText(exp.goal, 2500),
    contextTail: exp.contextTail?.slice(-8),
    corrections: exp.corrections?.slice(-10),
    skillsUsed: exp.skillsUsed,
    recoveries: exp.recoveries,
    verificationSteps: exp.verificationSteps,
    toolCalls: exp.toolCalls?.slice(-50)
  };
}
function candidatesPayload(candidates) {
  return candidates.map((x) => ({
    id: x.id,
    name: x.name,
    description: x.description,
    owned: Boolean(x.owned),
    scope: x.scope,
    sha256: x.sha256,
    supportingFiles: x.supportingFiles,
    body: x.owned ? trimText(x.body, 14e3) : void 0
  }));
}
function buildReviewPrompt({ exp, candidates }) {
  return `Review the completed experience below for durable procedural knowledge.

Allowed write scope: project only.

## Completed experience

\`\`\`json
${JSON.stringify(trajectoryPayload(exp), null, 2)}
\`\`\`

## Candidate skills

\`\`\`json
${JSON.stringify(candidatesPayload(candidates), null, 2)}
\`\`\`

Submit exactly one proposal through learning_submit_proposal. Create and patch decisions must include skillId as lowercase kebab-case with 1-64 characters. For a create, supporting files may be supplied as skill.files. For a patch, addFiles may create new supporting files but must never overwrite an existing supporting file. Do not edit files directly.`;
}
function buildValidationPrompt({ exp, candidates, proposal, deterministicValidation }) {
  return `Independently validate this proposed learned-skill change against the evidence.

## Completed experience

\`\`\`json
${JSON.stringify(trajectoryPayload(exp), null, 2)}
\`\`\`

## Candidate skills

\`\`\`json
${JSON.stringify(candidatesPayload(candidates), null, 2)}
\`\`\`

## Proposal

\`\`\`json
${JSON.stringify(proposal, null, 2)}
\`\`\`

## Deterministic validation

\`\`\`json
${JSON.stringify(deterministicValidation, null, 2)}
\`\`\`

Call learning_submit_validation exactly once. Reject unsupported generalization.`;
}

// learning/src/review-pipeline.js
var ReviewPipeline = class {
  constructor({ adapter, recorder, store, telemetry, mailbox, config }) {
    Object.assign(this, { adapter, recorder, store, telemetry, mailbox, config });
    this.inFlight = /* @__PURE__ */ new Set();
    this.forced = /* @__PURE__ */ new Set();
    this.disposed = false;
  }
  schedule(sessionID, { force = false } = {}) {
    if (this.disposed || !sessionID || this.mailbox.isInternalSession(sessionID) || this.inFlight.has(sessionID)) return;
    if (force) this.forced.add(sessionID);
  }
  executionFinished(sessionID) {
    if (this.disposed || !sessionID || this.mailbox.isInternalSession(sessionID)) return;
    const force = this.forced.delete(sessionID);
    void this.review(sessionID, { force }).catch((error) => {
      console.error("[opencode-learning] review failed", error);
    });
  }
  async review(sessionID, { force = false } = {}) {
    if (this.disposed || !this.config.enabled || this.inFlight.has(sessionID) || this.mailbox.isInternalSession(sessionID)) return { status: "skipped" };
    this.inFlight.add(sessionID);
    let shouldClear = false;
    let score;
    try {
      const exp = this.recorder.snapshot(sessionID);
      if (!exp) return { status: "no-experience" };
      score = scoreExperience(exp);
      if (!force && !isReviewCandidate(exp, this.config.scoreThreshold)) {
        shouldClear = true;
        return { status: "below-threshold", score };
      }
      const parent = await this.adapter.getSession(sessionID);
      const directory = parent?.location?.directory ?? this.store.projectRoot;
      const model = parent?.model;
      const candidates = await retrieveCandidates({
        exp,
        adapter: this.adapter,
        store: this.store,
        maxCandidates: this.config.maxCandidates
      });
      await this.telemetry.recordExperience(exp);
      const proposal = normalizeCreateProposal(await this.runReflector({ directory, model, exp, candidates }));
      proposal.scope = "project";
      const deterministic = validateProposal(proposal, {
        confidenceThreshold: this.config.confidenceThreshold
      });
      let agentValidation = { decision: "accept", reason: "agent validation disabled", warnings: [] };
      if (deterministic.ok && proposal.decision !== "none" && this.config.agentValidation) {
        agentValidation = await this.runValidator({ directory, model, exp, candidates, proposal, deterministic });
      }
      const validation = {
        deterministic,
        agent: agentValidation,
        ok: deterministic.ok && (proposal.decision === "none" || agentValidation.decision === "accept")
      };
      if (this.disposed) throw new Error("learning pipeline was disposed during review");
      await this.telemetry.recordReview({ sessionID, score, decision: proposal?.decision, skillId: proposal?.skillId, validation });
      shouldClear = true;
      if (!validation.ok || proposal.decision === "none") {
        if (this.config.notify && force) await this.adapter.notify(sessionID, `[opencode-learning] Review completed with no applied change: ${summarizeNoChange(proposal, validation)}`);
        return { status: "no-change", proposal, validation, score };
      }
      if (this.config.mode === "suggest") {
        const staged = await this.store.stage(proposal, validation);
        if (this.config.notify) await this.adapter.notify(sessionID, `[opencode-learning] Staged ${proposal.decision} proposal ${staged.id} for ${proposal.skillId}. Inspect with /learn-show ${staged.id} or /learn-pending.`);
        return { status: "staged", staged, proposal, validation, score };
      }
      const applied = proposal.decision === "create" ? await this.store.create(proposal, { scope: proposal.scope }) : await this.store.patch(proposal, { scope: proposal.scope });
      if (proposal.decision === "create") await this.telemetry.recordCreated(proposal.skillId);
      else await this.telemetry.recordPatched(proposal.skillId);
      await this.adapter.reloadSkills();
      if (this.config.notify) await this.adapter.notify(sessionID, `[opencode-learning] Applied ${proposal.decision} for learned skill ${proposal.skillId} and reloaded skills.`);
      return { status: "applied", applied, proposal, validation, score };
    } catch (error) {
      if (this.disposed) return { status: "disposed" };
      await this.telemetry.recordReview({ sessionID, score, decision: "error", error: redactError(error) }).catch(() => {
      });
      if (this.config.notify && force) await this.adapter.notify(sessionID, `[opencode-learning] Review failed: ${redactError(error)}`);
      throw error;
    } finally {
      this.inFlight.delete(sessionID);
      if (shouldClear) this.recorder.clear(sessionID);
    }
  }
  async runReflector({ directory, model, exp, candidates }) {
    const session = await this.adapter.createInternalSession({
      directory,
      model,
      agent: this.config.reflectorAgent,
      title: "Procedural skill reflection"
    });
    const id = session?.id;
    if (!id) throw new Error("OpenCode did not return a reflector session id");
    this.mailbox.register(id, "proposal");
    try {
      const callback = this.mailbox.wait(id, this.config.reviewerTimeoutMs);
      await this.adapter.prompt(id, buildReviewPrompt({ exp, candidates }));
      const proposal = await callback;
      if (!this.mailbox.hasSubmitted(id)) throw new Error("reflector finished without submitting a proposal");
      return proposal;
    } finally {
      this.mailbox.release(id);
      await this.adapter.interrupt(id);
    }
  }
  async runValidator({ directory, model, exp, candidates, proposal, deterministic }) {
    const session = await this.adapter.createInternalSession({
      directory,
      model,
      agent: this.config.validatorAgent,
      title: "Procedural skill validation"
    });
    const id = session?.id;
    if (!id) throw new Error("OpenCode did not return a validator session id");
    this.mailbox.register(id, "validation");
    try {
      const callback = this.mailbox.wait(id, this.config.reviewerTimeoutMs);
      await this.adapter.prompt(id, buildValidationPrompt({ exp, candidates, proposal, deterministicValidation: deterministic }));
      const validation = await callback;
      if (!this.mailbox.hasSubmitted(id)) throw new Error("validator finished without submitting a validation");
      return validation;
    } finally {
      this.mailbox.release(id);
      await this.adapter.interrupt(id);
    }
  }
  async cleanup() {
    this.disposed = true;
    this.forced.clear();
  }
};
function summarizeNoChange(proposal, validation) {
  if (proposal?.decision === "none") return proposal.reason || "nothing durable was found";
  if (!validation?.deterministic?.ok) return validation.deterministic.errors.join("; ");
  if (validation?.agent?.decision === "reject") return validation.agent.reason;
  return "no durable change";
}

// learning/src/curator.js
import path5 from "node:path";
var Curator = class {
  constructor({ config, store, telemetry }) {
    this.config = config;
    this.store = store;
    this.telemetry = telemetry;
    this.stateFile = path5.join(store.stateRoot, "curator.json");
  }
  async maybeRun({ force = false } = {}) {
    if (!this.config.curator.enabled) return { skipped: "disabled" };
    const state = await readJson(this.stateFile, { lastRunAt: 0 });
    const hours = (Date.now() - state.lastRunAt) / 36e5;
    if (!force && state.lastRunAt && hours < this.config.curator.checkEveryHours) return { skipped: "interval" };
    const result2 = await this.run();
    await writeJson(this.stateFile, { lastRunAt: Date.now(), result: result2 });
    return result2;
  }
  async run() {
    const archived = [];
    const stale = [];
    const owned = await this.store.listOwned("project");
    for (const item of owned) {
      const meta = this.telemetry.state.skills[item.skillId];
      const last = meta?.updatedAt ?? meta?.createdAt ?? Date.now();
      const age = daysSince(last);
      if (age >= this.config.curator.archiveAfterDays) {
        if (await this.store.archive(item.skillId, { scope: "project" })) {
          archived.push(item.skillId);
          if (meta) meta.state = "archived";
        }
      } else if (age >= this.config.curator.staleAfterDays) {
        stale.push(item.skillId);
        if (meta) meta.state = "stale";
      } else if (meta) {
        meta.state = "active";
      }
    }
    await this.telemetry.flush();
    return { stale, archived };
  }
};

// learning/src/index.js
var index_default = Plugin.define({
  id: "learning.skills",
  setup: async (ctx) => {
    const config = loadConfig(ctx.options);
    if (!config.enabled) return;
    const mailbox = new InternalMailbox();
    const adapter = new OpenCodeAdapter(ctx);
    const runtimes = /* @__PURE__ */ new Map();
    const sessionDirectories = /* @__PURE__ */ new Map();
    const runtimeForSession = async (sessionID) => {
      let directory = sessionDirectories.get(sessionID);
      if (!directory) {
        const session = await adapter.getSession(sessionID);
        directory = session?.location?.directory;
        if (!directory) throw new Error(`session ${sessionID} has no project directory`);
        directory = await canonicalDirectory(directory);
        sessionDirectories.set(sessionID, directory);
      }
      let runtime = runtimes.get(directory);
      if (!runtime) {
        runtime = createRuntime({ directory, config, adapter, mailbox });
        runtimes.set(directory, runtime);
      }
      await runtime.ready;
      return runtime;
    };
    await registerTools(ctx, { config, mailbox, adapter, runtimeForSession });
    adapter.start();
    const removeTerminalListener = adapter.onExecutionTerminal((event) => {
      if (!sessionDirectories.has(event.sessionID)) return;
      void runtimeForSession(event.sessionID).then((runtime) => {
        runtime.pipeline.executionFinished(event.sessionID);
        sessionDirectories.delete(event.sessionID);
      }).catch((error) => console.error("[opencode-learning] terminal event routing failed", error));
    });
    await ctx.session.hook("context", async (event) => {
      if (!event?.sessionID || mailbox.isInternalSession(event.sessionID)) return;
      const runtime = await runtimeForSession(event.sessionID);
      runtime.recorder.observeContext(event);
    });
    await ctx.tool.hook("execute.before", async (event) => {
      if (!event?.sessionID || mailbox.isInternalSession(event.sessionID) || isLearningTool(event.tool)) return;
      const runtime = await runtimeForSession(event.sessionID);
      runtime.recorder.toolBefore(event);
    });
    await ctx.tool.hook("execute.after", async (event) => {
      if (!event?.sessionID || mailbox.isInternalSession(event.sessionID) || isLearningTool(event.tool)) return;
      const runtime = await runtimeForSession(event.sessionID);
      const exp = runtime.recorder.toolAfter(event);
      if (!exp) return;
      if (event.tool === "skill") {
        const skillId = typeof event.input === "object" ? event.input?.name ?? event.input?.id ?? event.input?.skill : void 0;
        if (typeof skillId === "string") void runtime.telemetry.recordUse(skillId).catch(console.error);
      }
    });
    const curatorTimer = setInterval(
      () => {
        for (const runtime of runtimes.values()) {
          void runtime.curator.maybeRun().catch((error) => console.error("[opencode-learning] curator failed", error));
        }
      },
      Math.max(1, config.curator.checkEveryHours) * 36e5
    );
    curatorTimer.unref?.();
    return async () => {
      clearInterval(curatorTimer);
      removeTerminalListener();
      await Promise.allSettled([...runtimes.values()].map((runtime) => runtime.ready.then(() => runtime.pipeline?.cleanup())));
      await Promise.allSettled(mailbox.sessionIDs().map((id) => adapter.interrupt(id)));
      await adapter.dispose();
    };
  }
});
function createRuntime({ directory, config, adapter, mailbox }) {
  const store = new SkillStore({
    projectRoot: directory,
    projectSkillDir: config.projectSkillDir,
    globalSkillDir: config.globalSkillDir,
    stateDir: config.stateDir
  });
  const recorder = new ExperienceRecorder({ maxEventsPerSession: config.maxEventsPerSession });
  const runtime = { directory, store, recorder };
  runtime.ready = new Telemetry(store.stateRoot).load().then((telemetry) => {
    runtime.telemetry = telemetry;
    runtime.curator = new Curator({ config, store, telemetry });
    runtime.pipeline = new ReviewPipeline({ adapter, recorder, store, telemetry, mailbox, config });
    void runtime.curator.maybeRun().catch((error) => console.error("[opencode-learning] curator failed", error));
    return runtime;
  });
  return runtime;
}
async function canonicalDirectory(directory) {
  const resolved = path6.resolve(directory);
  try {
    return await fs3.realpath(resolved);
  } catch {
    return resolved;
  }
}
async function registerTools(ctx, { config, mailbox, adapter, runtimeForSession }) {
  await ctx.tool.transform((tools) => {
    const add = (name, info, options) => tools.add({ ...info, name, options });
    add("submit_proposal", {
      description: "Internal reflector-only tool. Submit exactly one structured procedural-skill proposal.",
      input: proposalInputSchema,
      output: objectOutput(),
      execute: async (proposal, toolCtx) => {
        enforceAgent(toolCtx, config.reflectorAgent, "proposal");
        mailbox.submit(toolCtx.sessionID, "proposal", proposal);
        return result({ accepted: true }, "Proposal received.");
      }
    }, { namespace: "learning", codemode: false });
    add("submit_validation", {
      description: "Internal validator-only tool. Accept or reject one procedural-skill proposal.",
      input: validationInputSchema,
      output: objectOutput(),
      execute: async (validation, toolCtx) => {
        enforceAgent(toolCtx, config.validatorAgent, "validation");
        mailbox.submit(toolCtx.sessionID, "validation", validation);
        return result({ accepted: true }, "Validation received.");
      }
    }, { namespace: "learning", codemode: false });
    add("request_review", {
      description: "Schedule a procedural-learning review after the current turn becomes idle.",
      input: {
        type: "object",
        properties: { force: { type: "boolean" } },
        additionalProperties: false
      },
      output: objectOutput(),
      execute: async ({ force = false }, toolCtx) => {
        const { pipeline } = await runtimeForSession(toolCtx.sessionID);
        pipeline.schedule(toolCtx.sessionID, { force });
        return result({ scheduled: true, force }, force ? "Forced learning review scheduled after this turn." : "Learning review scheduled after this turn.");
      }
    }, { namespace: "learning", codemode: false });
    add("pending", {
      description: "List, inspect, apply, or reject staged learned-skill proposals.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "show", "apply", "reject"] },
          id: { type: "string" }
        },
        required: ["action"],
        additionalProperties: false
      },
      output: objectOutput(),
      execute: async ({ action, id }, toolCtx) => {
        const { store, telemetry } = await runtimeForSession(toolCtx.sessionID);
        if (action === "list") {
          const pending = await store.listPending();
          const compact = pending.map((x) => ({
            id: x.id,
            decision: x.proposal?.decision,
            skillId: x.proposal?.skillId,
            scope: x.proposal?.scope,
            reason: x.proposal?.reason,
            confidence: x.proposal?.confidence,
            validation: x.validation
          }));
          return result({ pending: compact }, JSON.stringify(compact, null, 2));
        }
        if (!id) throw new Error("id is required for show/apply/reject");
        if (action === "show") {
          const pending = await store.getPending(id);
          return result(pending, JSON.stringify(pending, null, 2));
        }
        if (action === "reject") {
          await store.rejectPending(id);
          return result({ rejected: id }, `Rejected ${id}.`);
        }
        const applied = await store.applyPending(id);
        const skillId = applied.proposal?.skillId;
        if (typeof skillId === "string" && applied.result?.file) {
          if (applied.proposal.decision === "create") await telemetry.recordCreated(skillId);
          if (applied.proposal.decision === "patch") await telemetry.recordPatched(skillId);
        }
        await adapter.reloadSkills();
        return result({ applied: id, skillId, result: applied.result, reloaded: true }, `Applied ${id} to ${skillId} and reloaded skills.`);
      }
    }, { namespace: "learning", codemode: false });
    add("promote", {
      description: "Explicitly promote one plugin-owned project skill into the global OpenCode skill registry.",
      input: {
        type: "object",
        properties: { skillId: { type: "string" } },
        required: ["skillId"],
        additionalProperties: false
      },
      output: objectOutput(),
      execute: async ({ skillId }, toolCtx) => {
        const { store } = await runtimeForSession(toolCtx.sessionID);
        const promoted = await store.promote(skillId);
        await adapter.reloadSkills();
        return result({ ...promoted, reloaded: true }, `Promoted ${skillId} to global skills and reloaded the skill registry.`);
      }
    }, { namespace: "learning", codemode: false });
    add("status", {
      description: "Show procedural-learning configuration, native component availability, owned skills, pending proposals, and recent reviews.",
      input: { type: "object", properties: {}, additionalProperties: false },
      output: objectOutput(),
      execute: async (_, toolCtx) => {
        const { directory, store, telemetry } = await runtimeForSession(toolCtx.sessionID);
        const [projectSkills, pending, components] = await Promise.all([
          store.listOwned("project"),
          store.listPending(),
          componentStatus(ctx, config)
        ]);
        const output = {
          enabled: config.enabled,
          mode: config.mode,
          scoreThreshold: config.scoreThreshold,
          confidenceThreshold: config.confidenceThreshold,
          agentValidation: config.agentValidation,
          globalWrites: "explicit-promotion-only",
          projectRoot: directory,
          projectSkillDir: store.projectRootSkills,
          globalSkillDir: store.globalRootSkills,
          stateDir: store.stateRoot,
          components,
          ownedSkills: projectSkills.map((x) => ({ id: x.skillId, sha256: x.sha256, supportingFiles: x.supportingFiles })),
          pendingCount: pending.length,
          recentReviews: telemetry.recentReviews(10)
        };
        return result(output, JSON.stringify(output, null, 2));
      }
    }, { namespace: "learning", codemode: false });
    add("curate", {
      description: "Run deterministic stale/archive maintenance for agent-owned project skills. Never permanently deletes skills.",
      input: {
        type: "object",
        properties: { force: { type: "boolean" } },
        additionalProperties: false
      },
      output: objectOutput(),
      execute: async ({ force = false }, toolCtx) => {
        const { curator } = await runtimeForSession(toolCtx.sessionID);
        const output = await curator.maybeRun({ force });
        if (output.archived?.length) await adapter.reloadSkills();
        return result(output, JSON.stringify(output, null, 2));
      }
    }, { namespace: "learning", codemode: false });
  });
}
function enforceAgent(toolCtx, expected, kind) {
  if (toolCtx?.agent !== expected) throw new Error(`learning.submit_${kind} is restricted to ${expected}`);
}
async function componentStatus(ctx, config) {
  const out = { reflectorAgent: false, validatorAgent: false, commands: {} };
  try {
    const agentsRaw = await ctx.agent.list();
    const agents = unwrapList(agentsRaw);
    const ids = new Set(agents.map((x) => x.id ?? x.name));
    out.reflectorAgent = ids.has(config.reflectorAgent);
    out.validatorAgent = ids.has(config.validatorAgent);
  } catch {
  }
  try {
    const commandsRaw = await ctx.command.list();
    const commands = unwrapList(commandsRaw);
    const ids = new Set(commands.map((x) => x.id ?? x.name ?? x.command));
    for (const id of ["learn", "learn-pending", "learn-show", "learn-approve", "learn-reject", "learn-status", "learn-curate", "learn-promote"]) out.commands[id] = ids.has(id);
  } catch {
  }
  return out;
}
function unwrapList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}
function objectOutput() {
  return { type: "object", additionalProperties: true };
}
function result(output, content) {
  return { output: sanitize(output), content };
}
function sanitize(value) {
  if (value === void 0 || value === null) return null;
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v);
    return out;
  }
  return value;
}
function isLearningTool(name) {
  return typeof name === "string" && (name.startsWith("learning.") || name.startsWith("learning_"));
}
export {
  index_default as default
};
