# Procedural Learning Scoring V2 Implementation Plan

> **For implementers:** Follow this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace activity-volume scoring with deterministic closed-loop learning signals that can run repeatedly without producing frequent, low-value reflections.

**Architecture:** Keep event recording and review orchestration in the existing plugin, but move trigger feature extraction and scoring into a focused pure module. A batch qualifies only from an explicit incorporated correction, a confirmed recovery, or a repeated objectively verified workflow; raw tool-call volume contributes no points. Workflow-only reviews are deferred for three successful turns, qualifying evidence is retained while deferred, and equivalent accepted or no-change candidates are suppressed within the session.

**Tech Stack:** JavaScript-compatible TypeScript, Node.js 24 built-ins, OpenCode V2 promise plugin API, JSON telemetry.

**Spec or source of requirements:** User request in this session, the existing implementation in `plugins/opencode-learning/index.ts`, and the read-only OpenCode database/telemetry calibration summarized below.

## Global Constraints

- Raw tool-call count contributes exactly `0` trigger points; calls remain available as reflector evidence.
- Trigger evaluation remains deterministic and must not invoke a model.
- Automatic evaluation occurs only after successful root foreground executions.
- Explicit `/learn` continues to bypass score, signal, cadence, and duplicate-suppression checks.
- Internal reflector/validator sessions and all `learning.*` or `learning_*` tools remain excluded.
- A reviewed batch is consumed exactly once; a deferred batch remains intact until eligible.
- At most one review may run for a foreground session at a time.
- Existing telemetry skills and reviews must survive the telemetry schema upgrade.
- No prompt text, tool input, credentials, or unhashed operation targets may be added to telemetry.
- Do not add runtime dependencies.
- Do not add test files; verification uses pure-module scenarios, syntax checks, telemetry inspection, and an isolated OpenCode reproduction.

## Calibration Baseline

The read-only snapshot covered approximately 20 hours of activity:

| Metric | Observed |
| --- | ---: |
| Total sessions | 79 |
| Foreground root sessions | 28 |
| Internal reflector/validator root sessions | 28 |
| Foreground turns | 90 |
| Successful foreground turns | 57 |
| Non-learning tool calls | 805 |

Replaying the current unlimited algorithm produced 16 reviews from 57 successful turns, or one review per 3.6 successful turns. Thresholds `10` and `15` both produced 16 reviews because uncapped tool volume dominated the score. Recent automatic telemetry contained 14 reviews: 6 accepted proposals, 7 no-change outcomes, and 1 error. The broad correction regex matched 9 of 62 follow-up messages, while a beginning-anchored correction detector matched 2.

The initial V2 targets are:

- Automatic candidates at or below 15% of successful turns.
- No-change outcomes below 25% after at least 100 automatic reviews.
- No repeated review of an equivalent candidate fingerprint in one session.
- No loss of qualifying evidence solely because a cadence gate is active.

## File Map

- Create `plugins/opencode-learning/scoring.ts`: Pure normalization, feature extraction, scoring, eligibility, and candidate fingerprinting. It must not access OpenCode APIs or mutable plugin state.
- Modify `plugins/opencode-learning/index.ts`: Record turn boundaries, call the V2 scorer, retain deferred evidence, enforce workflow cadence and fingerprint suppression, retry technical review failures once, and expose trigger telemetry.
- Modify `README.md`: Document V2 signals, score, cadence, telemetry, and updated configuration defaults.
- Modify `SCORING.md`: During implementation, check off completed steps and record final calibration output in the final task.

---

### Task 1: Pure V2 Scoring Module

**Files:**
- Create: `plugins/opencode-learning/scoring.ts`

**Interfaces:**
- Consumes: Experience snapshots containing `toolCalls`, `correctionSignals`, and completed `turns` produced by Task 2.
- Produces: `classifyToolCall(record)`, `operationFingerprint(record)`, `isExplicitCorrection(text)`, `deriveTriggerFeatures(experience)`, `scoreReviewCandidate(features, threshold)`, and `candidateFingerprint(features)`.
- Produces: A trigger decision shaped as `{ eligible, score, threshold, strongSignals, workflowOnly, fingerprint, reasons }`.

- [ ] **Step 1: Define constants and privacy-safe normalization helpers**

Create `plugins/opencode-learning/scoring.ts` with these exported constants:

```js
export const DEFAULT_SCORE_THRESHOLD = 12;
export const WORKFLOW_COOLDOWN_TURNS = 3;

const INSPECTION_TOOLS = new Set(["read", "grep", "glob", "webfetch", "websearch", "skill"]);
const MUTATION_TOOLS = new Set(["patch", "edit", "write"]);
const EXECUTION_TOOLS = new Set(["shell", "execute", "bash"]);
```

Add `stableHash(value)` using `crypto.createHash("sha256")`. Hash normalized operations before returning fingerprints; never return raw command text, paths, queries, URLs, or tool input.

Add `stripQuotedContent(text)` that removes fenced code blocks, Markdown blockquotes, and quoted inline fragments before correction matching.

- [ ] **Step 2: Implement strict explicit-correction detection**

Export `isExplicitCorrection(text)`. Match only near the beginning of the cleaned follow-up message:

```js
const EXPLICIT_CORRECTION_RE = /^\s*(?:
  no\b|nope\b|not\s+quite\b|
  that(?:'s|\s+is)\s+(?:not\s+right|wrong)\b|
  wrong\b|correction\b|
  actually[, :]\s*|instead[, :]\s*|
  you\s+(?:missed|should|shouldn't|need\s+to)\b
)/ix;
```

JavaScript does not support free-spacing regex syntax, so implement the equivalent as one valid regex literal. Do not include bare `must`, `never`, `do not`, `should not`, or an unanchored `no`.

- [ ] **Step 3: Classify tool outcomes rather than count calls**

Export `classifyToolCall(record)` returning one of:

```text
inspect
mutate
execute
verify
delegate
other
```

A verification must have `status === "success"` and match a recognized command family extracted from the tool input:

```text
npm|pnpm|yarn|bun test|lint|typecheck|check|build
pytest|python -m pytest
go test
cargo test|check|clippy|build
zig build
make test|check|build
gradle|./gradlew test|check|build
mvn test|verify
dotnet test|build
```

Failed checks remain failures and do not count as verification. A filename or arbitrary argument containing `test`, `check`, or `build` must not qualify by itself.

- [ ] **Step 4: Normalize operation identity for recovery detection**

Export `operationFingerprint(record)` as a SHA-256 hash over a normalized object:

```js
{
  tool: record.tool,
  operation: normalizedExecutableAndSubcommand,
  target: firstDefined(record.input.path, record.input.file, record.input.uri, record.input.id, record.input.name),
}
```

For shell-like tools, normalize the executable and first subcommand but omit flags and values. Also calculate an internal full-input hash so recovery requires the same operation fingerprint and materially different input.

A confirmed recovery is an error followed by a successful equivalent operation within the next two non-inspection calls. Merely using the same tool name is insufficient.

- [ ] **Step 5: Derive capped closed-loop features**

Export `deriveTriggerFeatures(experience)` with this result:

```js
{
  incorporatedCorrections,
  confirmedRecoveries,
  repeatedVerifiedWorkflows,
  successfulVerificationsAfterMutation,
  unresolvedFailures,
  distinctCategories,
  signalFingerprints,
}
```

Apply these definitions:

- An incorporated correction requires an explicit correction signal followed in the same or a later successful turn by a successful mutation or execution.
- A confirmed recovery uses the operation matching from Step 4.
- An unresolved failure is a failed operation not paired with a confirmed recovery in the current batch.
- A verified workflow turn contains a successful mutation followed by a successful recognized verification before that turn succeeds.
- A repeated verified workflow requires the same hashed category/operation sequence in at least two successful turns in the current batch.
- Verification before mutation does not close a workflow.
- Cap feature counts during scoring, not while retaining reflector evidence.

- [ ] **Step 6: Implement score and eligibility**

Export `scoreReviewCandidate(features, threshold = DEFAULT_SCORE_THRESHOLD)` using:

```text
C = min(incorporatedCorrections, 1)
R = min(confirmedRecoveries, 2)
W = min(repeatedVerifiedWorkflows, 1)
V = min(successfulVerificationsAfterMutation, 2)
F = min(unresolvedFailures, 2)
D = min(distinctCategories, 3)

score = 12*C + 8*R + 8*W + 2*V + 1*F + 1*D
eligible = score >= threshold AND (C > 0 OR R > 0 OR W > 0)
workflowOnly = W > 0 AND C == 0 AND R == 0
```

The returned `reasons` object contains only numeric counts. `candidateFingerprint(features)` hashes the sorted strong-signal fingerprints and must not include raw evidence.

- [ ] **Step 7: Verify pure scoring scenarios**

Run:

```sh
node --experimental-strip-types --input-type=module <<'NODE'
import assert from "node:assert/strict";
import {
  isExplicitCorrection,
  scoreReviewCandidate,
} from "./plugins/opencode-learning/scoring.ts";

assert.equal(isExplicitCorrection("No, patch the source file instead."), true);
assert.equal(isExplicitCorrection("The code must never write generated output."), false);
assert.equal(isExplicitCorrection("Run this: `echo no`"), false);

assert.equal(scoreReviewCandidate({
  incorporatedCorrections: 1,
  confirmedRecoveries: 0,
  repeatedVerifiedWorkflows: 0,
  successfulVerificationsAfterMutation: 1,
  unresolvedFailures: 0,
  distinctCategories: 2,
  signalFingerprints: ["correction-a"],
}).eligible, true);

assert.equal(scoreReviewCandidate({
  incorporatedCorrections: 0,
  confirmedRecoveries: 0,
  repeatedVerifiedWorkflows: 0,
  successfulVerificationsAfterMutation: 2,
  unresolvedFailures: 0,
  distinctCategories: 3,
  signalFingerprints: [],
}).eligible, false);
NODE
```

Expected: no output and exit code `0`.

### Task 2: Turn-Aware Experience Recording

**Files:**
- Modify: `plugins/opencode-learning/index.ts:141-261`

**Interfaces:**
- Consumes: Existing context hooks, tool hooks, and terminal events.
- Produces: Experience snapshots with `correctionSignals`, per-tool `turn`, completed `turns`, and compatibility summaries for existing reflector/skill telemetry. V2 trigger features are derived from ordered records, not compatibility counters.

- [ ] **Step 1: Extend recorder state without changing reflector evidence**

Add these fields when `ExperienceRecorder.get(sessionID)` initializes a batch:

```js
correctionSignals: [],
turn: 0,
turns: [],
```

Keep `corrections` as strings because reflector prompts already consume them. Keep `toolCalls` unchanged except for the new numeric `turn` field.

- [ ] **Step 2: Record strict correction signals once**

Import `isExplicitCorrection` from `./scoring.ts`. In `observeContext()`, preserve the existing `seenUserMessages` deduplication and append:

```js
{
  turn: exp.turn,
  fingerprint: sha256(fingerprint),
}
```

to `correctionSignals` only when `item.followsAssistant` and `isExplicitCorrection(item.text)` are both true. Continue retaining the original correction text in `corrections` for reflector evidence, but replace the broad `CORRECTION_RE` gate with the strict detector so telemetry and prompts agree.

- [ ] **Step 3: Associate tool outcomes with the active turn**

Add `turn: exp.turn` to each `toolAfter()` record. Keep status, input, result, duration, and timestamp behavior unchanged. Retain `recoveries` and `verificationSteps` as compatibility summaries for existing reflector prompts and skill telemetry, but do not use them for V2 trigger eligibility; V2 recalculates relationships from ordered records.

- [ ] **Step 4: Close turns from terminal events**

Add:

```js
finishTurn(sessionID, terminalType, eventID) -> ExperienceSnapshot | undefined
```

It appends:

```js
{
  turn: exp.turn,
  terminalType,
  succeeded: terminalType === "session.execution.succeeded",
}
```

then increments `exp.turn`. Ignore a duplicate terminal `eventID` so reconnects or duplicate delivery cannot close two turns. Session-lifetime successful-turn cadence belongs to `ReviewPipeline`, not the resettable evidence batch.

In the terminal listener at `plugins/opencode-learning/index.ts:1351-1362`, enqueue terminal handling through the same per-session promise chain used by tool hooks. The queued operation must call `finishTurn()` and then `executionFinished()` in order. Do not rely on the two independent async callbacks being naturally ordered.

- [ ] **Step 5: Preserve batch reset and deduplication semantics**

Update `snapshot()` to clone `correctionSignals` and `turns`. Keep `take()` deleting only the active batch, but clear or tombstone that session's `pendingTools` entries so a late `toolAfter` cannot consume a `toolBefore` from the captured batch. Keep `history.goal` and `history.seenUserMessages` outside the batch so reviewed user corrections cannot be counted again. The per-session hook chain must complete `toolAfter` before terminal handling can call `take()` in normal operation.

- [ ] **Step 6: Verify recorder integration**

Run:

```sh
node --check plugins/opencode-learning/index.ts
rg -n 'CORRECTION_RE|verificationSteps|recoveries \+=' plugins/opencode-learning/index.ts
```

Expected: syntax succeeds; the search returns no obsolete broad correction detector used for trigger decisions. Compatibility references to `recoveries` and `verificationSteps` are allowed when they are derived summaries for existing prompts/skill telemetry.

### Task 3: Candidate Gating, Deferred Cadence, And Suppression

**Files:**
- Modify: `plugins/opencode-learning/index.ts:1098-1260`

**Interfaces:**
- Consumes: `scoreReviewCandidate(deriveTriggerFeatures(exp), config.scoreThreshold)` and `candidateFingerprint(features)` from Task 1.
- Produces: Pipeline decisions `below-threshold`, `missing-strong-signal`, `workflow-cooldown`, `duplicate-fingerprint`, or `review` for Task 4 telemetry.

- [ ] **Step 1: Replace the old score and signal functions**

Import `DEFAULT_SCORE_THRESHOLD`, `WORKFLOW_COOLDOWN_TURNS`, `deriveTriggerFeatures`, and `scoreReviewCandidate` from `./scoring.ts`.

Delete `VERIFY_RE`, `scoreExperience()`, `hasLearningSignal()`, and the old `isReviewCandidate()`. Set `DEFAULTS.scoreThreshold` to `DEFAULT_SCORE_THRESHOLD` and add:

```js
workflowCooldownTurns: WORKFLOW_COOLDOWN_TURNS,
```

Do not reintroduce `maxAutomaticReviewsPerSession`.

- [ ] **Step 2: Track cadence and reviewed fingerprints**

Add these `ReviewPipeline` maps:

```js
this.lastAutomaticReviewTurn = new Map();
this.successfulTurns = new Map();
this.reviewedFingerprints = new Map();
this.lastSuppressedFingerprint = new Map();
```

`reviewedFingerprints` maps `sessionID` to a map of fingerprint to `accepted` or `no-change`. `lastSuppressedFingerprint` prevents the same retained duplicate batch from incrementing suppression telemetry after every successful turn. Increment `successfulTurns` in `executionFinished()` only for `session.execution.succeeded`, before the in-flight branch. Clear all four maps in `cleanup()`.

- [ ] **Step 3: Evaluate without consuming deferred evidence**

In `start()`, snapshot and score before calling `recorder.take()`.

Use this order:

```text
disposed/internal/in-flight
forced review bypass
score and strong-signal eligibility
same-session fingerprint suppression
workflow-only cooldown
take batch
launch review
```

For workflow-only candidates, defer while:

```js
(this.successfulTurns.get(sessionID) ?? 0) - lastAutomaticReviewTurn < config.workflowCooldownTurns
```

Return without calling `take()`. New evidence therefore merges into the pending batch. Incorporated corrections and confirmed recoveries bypass workflow cadence but not the in-flight guard.

- [ ] **Step 4: Preserve one in-flight review and fresh-batch behavior**

Keep `inFlight` and `pending`. Delete a non-forced request on every terminal event before returning; only a forced request may bypass a failed/interrupted terminal. When a terminal event arrives during reflection, record one pending reevaluation, preserve force if any pending request is forced, and let the latest terminal type label that pending request. `drain()` must score the fresh batch after the current review settles; it must never reuse the captured batch.

- [ ] **Step 5: Suppress equivalent reviewed candidates**

When `review()` returns `staged` or `applied`, store the fingerprint as `accepted`. When it returns `no-change`, store it as `no-change`. A later candidate with the same fingerprint is retained but not reflected until a new incorporated correction or confirmed recovery changes the fingerprint. Record `duplicate-fingerprint` telemetry only when the fingerprint differs from `lastSuppressedFingerprint`; clear the last-suppressed marker when the candidate fingerprint changes.

Do not suppress `error`. Rename the current model-running body to:

```js
reviewAttempt(sessionID, exp, { force, terminalType, triggerDecision })
```

and add:

```js
async reviewWithRetry(sessionID, exp, options) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await this.reviewAttempt(sessionID, exp, options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
```

Each attempt creates fresh internal reflector/validator sessions and always releases them through the existing `finally` blocks. Call `recordExperience(exp)` once before the first attempt. Keep staging/applying, skill reload, and final review telemetry outside the retry boundary: retry only reflector/validator work before any project write. Move error telemetry and forced-session error notification outside `reviewAttempt()` so the final error is recorded exactly once after both attempts fail. After the second error, discard that captured batch and do not enter another automatic retry loop. A telemetry flush failure must be isolated and must not cause the model attempt to repeat.

- [ ] **Step 6: Update reflector evidence with V2 reasons**

Pass the trigger decision into `buildReflectionPrompt()`. Include numeric V2 reasons and strong-signal kinds in the prompt. Do not include the candidate fingerprint or claim that score itself proves a reusable lesson.

- [ ] **Step 7: Verify gating behavior with synthetic decisions**

Run the pure-module command from Task 1, then run:

```sh
node --check plugins/opencode-learning/index.ts
node --check plugins/opencode-learning/scoring.ts
git diff --check
```

Expected: all commands exit `0`.

Manually inspect `ReviewPipeline.start()` and confirm `recorder.take(sessionID)` occurs only after eligibility, suppression, and cooldown checks.

### Task 4: Versioned Trigger Telemetry

**Files:**
- Modify: `plugins/opencode-learning/index.ts:693-767`
- Modify: `plugins/opencode-learning/index.ts:1558-1586`

**Interfaces:**
- Consumes: Pipeline decision, V2 numeric reasons, signal kinds, review status, and proposal decision.
- Produces: Backward-compatible telemetry version 3 and aggregate `triggerStats` in `/learn-status`.

- [ ] **Step 1: Migrate telemetry state in place**

Export a pure `normalizeTelemetryState(state)` helper from `index.ts`. Set telemetry version to `3`, preserve existing `skills` and `reviews`, and initialize absent aggregate state as. The loader must normalize a malformed or missing `skills`/`reviews` value to the expected object/array without discarding valid entries:

```js
triggerStats: {
  version: 1,
  successfulTurns: 0,
  eligible: 0,
  deferred: 0,
  suppressed: 0,
  automaticReviews: 0,
  accepted: 0,
  noChange: 0,
  errors: 0,
  signals: { correction: 0, recovery: 0, workflow: 0 },
  scores: { below12: 0, from12To15: 0, from16To23: 0, atLeast24: 0 },
}
```

Do not rewrite or discard legacy reviews that lack V2 fields.

- [ ] **Step 2: Record aggregate evaluation outcomes**

Add `recordTriggerEvaluation({ decision, score, strongSignals })`. Increment one successful-turn count and exactly one decision counter per successful evaluation. Increment fixed score buckets and signal counters. Flush through the existing telemetry queue. Make the queued write recover from a rejected prior write so one transient failure cannot poison all future telemetry updates; callers must catch telemetry errors independently of review retry logic.

Do not store message text, tool inputs, raw paths, commands, URLs, or operation fingerprints in aggregate telemetry.

- [ ] **Step 3: Add V2 metadata to review records**

Extend new `recordReview()` items with:

```js
triggerVersion: 2,
triggerScore: number,
triggerReasons: numericCountsOnly,
triggerSignals: ["correction" | "recovery" | "workflow"],
```

Keep `score` for compatibility, but make it the V2 score object. Do not attach the private candidate fingerprint.

- [ ] **Step 4: Count final outcomes once**

Increment `automaticReviews` when an automatic reflector begins. Increment `accepted`, `noChange`, or `errors` only after the final result, including the one allowed technical retry. Forced `/learn` reviews remain in `reviews` but do not affect automatic trigger-rate counters.

- [ ] **Step 5: Expose calibration in `/learn-status`**

Add `triggerVersion: 2`, `workflowCooldownTurns`, and `triggerStats` to status output. Remove any remaining `maxAutomaticReviewsPerSession` output. Keep paths, components, owned skills, pending count, and recent reviews unchanged.

- [ ] **Step 6: Verify telemetry migration safely**

Copy one existing telemetry file and run the pure migration helper against it:

```sh
cp .opencode/.learning/telemetry.json /tmp/opencode/telemetry-v2-fixture.json
node --experimental-strip-types --input-type=module <<'NODE'
import fs from "node:fs";
import assert from "node:assert/strict";
import { normalizeTelemetryState } from "./plugins/opencode-learning/index.ts";

const before = JSON.parse(fs.readFileSync("/tmp/opencode/telemetry-v2-fixture.json", "utf8"));
const skillCount = Object.keys(before.skills ?? {}).length;
const reviewCount = (before.reviews ?? []).length;
const after = normalizeTelemetryState(structuredClone(before));
assert.equal(after.version, 3);
assert.equal(Object.keys(after.skills).length, skillCount);
assert.equal(after.reviews.length, reviewCount);
assert.equal(typeof after.triggerStats.successfulTurns, "number");
NODE
```

Expected: `version` is `3`, existing skills/reviews remain present, and `triggerStats` contains only aggregate numeric fields.

### Task 5: Configuration And Documentation

**Files:**
- Modify: `README.md:91-117`
- Modify: `README.md:187-255`
- Modify: `README.md:278-299`

**Interfaces:**
- Consumes: Final defaults and behavior from Tasks 1-4.
- Produces: User-facing configuration and an exact explanation of automatic reflection cadence.

- [ ] **Step 1: Update the configuration example**

Set:

```jsonc
"scoreThreshold": 12,
"workflowCooldownTurns": 3
```

Do not include `maxAutomaticReviewsPerSession`.

- [ ] **Step 2: Replace the old scoring table**

Document the capped V2 formula exactly. State explicitly that raw tool calls, skill loads, failed checks, and keyword matches do not earn points by themselves.

- [ ] **Step 3: Document closed-loop signals**

Give one concise example each for:

```text
explicit correction -> changed action -> successful completion
failed operation -> materially changed equivalent retry -> success
mutation -> recognized successful verification, repeated on another successful turn
```

Explain that the trigger is ordinary plugin code; agents run only after deterministic qualification.

- [ ] **Step 4: Document cadence and suppression**

State that workflow-only candidates wait for three successful turns after the previous automatic review, evidence accumulates while waiting, correction/recovery candidates bypass workflow cadence, and equivalent accepted/no-change fingerprints are not reviewed repeatedly in the same session.

- [ ] **Step 5: Update the options table and status documentation**

Set `scoreThreshold` default to `12`. Add `workflowCooldownTurns` default `3`. Describe `/learn-status` trigger counters and the target interpretation for accepted, no-change, deferred, and suppressed outcomes.

- [ ] **Step 6: Verify documentation consistency**

Run:

```sh
rg -n 'maxAutomaticReviewsPerSession|Each tool call|automatic-review-limit' README.md plugins/opencode-learning
git diff --check
```

Expected: the search has no matches and the diff check exits `0`.

### Task 6: End-To-End Verification And Calibration Gate

**Files:**
- Modify: `SCORING.md`

**Interfaces:**
- Consumes: Completed plugin and telemetry from Tasks 1-5.
- Produces: Verified plugin loading, deterministic scenario results, and recorded rollout evidence.

- [ ] **Step 1: Run static verification**

Run:

```sh
node --check plugins/opencode-learning/index.ts
node --check plugins/opencode-learning/scoring.ts
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 2: Run the focused deterministic scenarios**

Run:

```sh
node --experimental-strip-types --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { deriveTriggerFeatures, scoreReviewCandidate } from "./plugins/opencode-learning/scoring.ts";

const decision = (experience) => scoreReviewCandidate(deriveTriggerFeatures(experience));
const turn = (number) => ({ turn: number, succeeded: true, terminalType: "session.execution.succeeded" });
const tool = (name, status, input, turnNumber) => ({ tool: name, status, input, turn: turnNumber });

assert.equal(decision({
  toolCalls: Array.from({ length: 100 }, (_, i) => tool("read", "success", { path: `file-${i}` }, 0)),
  correctionSignals: [],
  turns: [turn(0)],
}).eligible, false);

assert.equal(decision({
  toolCalls: [
    tool("shell", "error", { command: "npm test" }, 0),
    tool("shell", "error", { command: "npm test" }, 0),
  ],
  correctionSignals: [],
  turns: [turn(0)],
}).eligible, false);

assert.equal(decision({
  toolCalls: [],
  correctionSignals: [{ turn: 0, fingerprint: "correction-a" }],
  turns: [turn(0)],
}).eligible, false);

assert.equal(decision({
  toolCalls: [tool("patch", "success", { path: "src/a.ts" }, 0)],
  correctionSignals: [{ turn: 0, fingerprint: "correction-a" }],
  turns: [turn(0)],
}).eligible, true);

assert.equal(deriveTriggerFeatures({
  toolCalls: [
    tool("read", "error", { path: "src/a.ts" }, 0),
    tool("read", "success", { path: "src/b.ts" }, 0),
  ],
  correctionSignals: [],
  turns: [turn(0)],
}).confirmedRecoveries, 0);

assert.equal(deriveTriggerFeatures({
  toolCalls: [
    tool("shell", "error", { command: "npm test -- --old" }, 0),
    tool("read", "success", { path: "package.json" }, 0),
    tool("shell", "success", { command: "npm test -- --new" }, 0),
  ],
  correctionSignals: [],
  turns: [turn(0)],
}).confirmedRecoveries, 1);

const verifiedTurn = (number) => [
  tool("patch", "success", { path: "src/a.ts" }, number),
  tool("shell", "success", { command: "npm test" }, number),
];
assert.equal(deriveTriggerFeatures({
  toolCalls: verifiedTurn(0), correctionSignals: [], turns: [turn(0)],
}).repeatedVerifiedWorkflows, 0);
assert.equal(deriveTriggerFeatures({
  toolCalls: [...verifiedTurn(0), ...verifiedTurn(1)], correctionSignals: [], turns: [turn(0), turn(1)],
}).repeatedVerifiedWorkflows, 1);
NODE
```

Expected: no output and exit code `0`.

- [ ] **Step 3: Reload the development plugin**

If the current standalone development TUI has not hot-reloaded the changed modules, run the project instruction:

```sh
kill -TERM "$(pgrep -n -f '^opencode2 --standalone( |$)')"
```

Restart OpenCode standalone from the repository root and confirm the log contains an active load for `plugins/opencode-learning/index.ts` with no plugin error.

- [ ] **Step 4: Verify user-visible status**

Run `/learn-status` in a disposable foreground session.

Expected:

```text
triggerVersion: 2
scoreThreshold: 12
workflowCooldownTurns: 3
triggerStats present
maxAutomaticReviewsPerSession absent
```

- [ ] **Step 5: Verify forced review remains independent**

In the disposable session, run `/learn` before the batch qualifies.

Expected: one forced review is scheduled after the turn despite score, signal, cadence, and fingerprint state. It must not increment automatic trigger counters.

- [ ] **Step 6: Record initial rollout measurements**

After at least 100 successful foreground turns, append an `Implementation Results` section to this file containing only aggregate `/learn-status` counters. Compare:

```text
eligible / successfulTurns <= 0.15
noChange / automaticReviews < 0.25
suppressed > 0 is acceptable when duplicate fingerprints recur
errors are reported separately and never treated as no-change
```

If trigger rate exceeds 15%, first tighten signal definitions; do not raise the threshold solely to offset raw activity. If no-change exceeds 25%, inspect aggregate outcomes by signal kind and tighten the weakest signal in a new versioned change.

## Execution Handoff

Plan complete. Two execution options:

1. **Task-by-task in this session** - Execute one task at a time with review between tasks.
2. **Separate execution session** - Start a fresh session with this plan supplied as its initial context and execute it with checkpoints.

Which approach?
