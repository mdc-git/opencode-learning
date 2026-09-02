# Review: opencode-learning changes vs SCORING.md

## Overview

`SCORING.md` is a 6-task implementation plan ("Procedural Learning Scoring V2") to replace activity-volume scoring with deterministic closed-loop learning signals. The uncommitted changes implement **only a fraction** of that plan.

### What changed (git status)

- **New:** `plugins/opencode-learning/scoring.ts` (1012 lines) — the pure V2 scoring module (Task 1).
- **New (untracked):** `cli.json` — local OpenCode theme/session config, unrelated to the plan.
- **Modified:** `plugins/opencode-learning/index.ts` — only removes `maxAutomaticReviewsPerSession` and its enforcement. Does NOT import or use `scoring.ts`.
- **Modified:** `README.md` — only removes `maxAutomaticReviewsPerSession` references. Does NOT update the scoring table, defaults, or documentation per the plan.

### Plan completion by task

| Task | Status |
|------|--------|
| Task 1: Pure V2 Scoring Module | **Mostly complete** — module created, all spec verification scenarios pass. One Important + two Minor findings (below). |
| Task 2: Turn-Aware Experience Recording | **Not started** — `index.ts` still uses `CORRECTION_RE`, `VERIFY_RE`, no `turn`/`turns`/`correctionSignals` fields, no `finishTurn()`, no per-session promise chain for terminal events. |
| Task 3: Candidate Gating, Deferred Cadence, Suppression | **Not started** — `index.ts` still calls old `isReviewCandidate()`/`scoreExperience()`/`hasLearningSignal()`. No `deriveTriggerFeatures`/`scoreReviewCandidate` import. No cadence maps, fingerprint suppression, or `reviewWithRetry`. |
| Task 4: Versioned Trigger Telemetry | **Not started** — telemetry still version 2, no `triggerStats`, no `normalizeTelemetryState`, no V2 review-record metadata. |
| Task 5: Configuration and Documentation | **Partially done** — `maxAutomaticReviewsPerSession` removed from README/options table. But scoring table still shows old per-tool-call points (`Each tool call | 1`), `scoreThreshold` default still says `10` (should be `12`), no `workflowCooldownTurns` documented, no closed-loop signal examples. |
| Task 6: End-to-End Verification | **Partially done** — syntax checks pass, deterministic scoring scenarios pass. No plugin reload, no `/learn-status` verification, no calibration gate. |

**Critical integration gap:** `index.ts` does not import `scoring.ts` at all. The new module is dead code — the plugin still runs entirely on the old V1 scoring algorithm. Grep confirms zero references to any `scoring.ts` export inside `index.ts`.

---

## Fresh review of scoring.ts (Task 1)

A context-isolated reviewer inspected `scoring.ts` against Task 1 of the spec. **Status: Needs fixes.**

### Findings

#### [Important] — Shared `VERIFICATION_COMMANDS` set over-broadens make and gradle families

- **Location:** `scoring.ts:14` (definition), `:559` (make), `:563` (gradle)
- **Problem:** A single shared `VERIFICATION_COMMANDS` set (`test, lint, typecheck, type-check, check, build, compile, smoke`) is used for npm/pnpm/yarn/bun, make, and gradle. The spec defines narrower families:
  - npm/pnpm/yarn/bun: `test|lint|typecheck|check|build`
  - make: `test|check|build` only
  - gradle/gradlew: `test|check|build` only

  Additionally, `compile`, `smoke`, and `type-check` are not in the spec for ANY tool family.
- **Trigger and impact:** `make lint` and `gradle lint` are classified as `"verify"` when they should be `"execute"`. If such a pattern repeats across two successful turns after a mutation, it yields `repeatedVerifiedWorkflows = 1` (W=1, 8 points), which can produce a false `workflowOnly` eligibility. This risks inflating the trigger rate above the 15% calibration target. Confirmed: `classifyToolCall({tool:"shell",status:"success",input:{command:"make lint"}})` returns `"verify"`.
- **Suggested fix:** Use per-family command sets. make/gradle: `new Set(["test","check","build"])`. npm family: `new Set(["test","lint","typecheck","check","build"])` (drop `type-check`, `compile`, `smoke`).

#### [Minor] — Shell tokenizer treats single `&`/`|` as `&&`/`||`, breaking `2>&1` and pipe recognition

- **Location:** `scoring.ts:336-339`
- **Problem:** Single `|` (pipe) is tokenized as `||` (logical OR), and single `&` as `&&`. While this doesn't break command segmentation (both are in `CONTROL_FLOW_TOKENS`), `2>&1` redirections split the command into two segments. `isRecognizedVerification` requires `segments.length === 1`, so `npm test 2>&1` and `npm test | tee out.log` both fail verification recognition.
- **Trigger and impact:** Very common commands like `npm test 2>&1` are classified as `"execute"` instead of `"verify"` — false negatives that reduce sensitivity (no false positives).
- **Suggested fix:** Push the single character when the next char doesn't match: `tokens.push(text[index+1] === char ? char+char : char)`. Consider handling `>`/`<` redirections too.

#### [Minor] — `strongSignalEntries` includes entries with empty-string kind in candidate fingerprint

- **Location:** `scoring.ts:969`
- **Problem:** The guard `if (kind && !STRONG_SIGNAL_KINDS.has(kind)) continue` short-circuits when `kind` is `""` (falsy), so entries with an empty-string kind pass through into the candidate fingerprint. Entries with a non-empty bogus kind are correctly excluded.
- **Trigger and impact:** In normal operation `deriveTriggerFeatures` always produces valid kinds, so this only manifests when `candidateFingerprint` is called directly with malformed input. Confirmed: `candidateFingerprint({signalFingerprints:[{kind:"",fingerprint:"abc"}]})` differs from `candidateFingerprint({signalFingerprints:[]})`.
- **Suggested fix:** Change to `if (!STRONG_SIGNAL_KINDS.has(kind)) continue`.

### Strengths (from the fresh review)

- Scoring formula is exact — all six coefficients (12, 8, 8, 2, 1, 1), caps (1, 2, 1, 2, 2, 3), eligibility gate, and `workflowOnly` match the spec precisely.
- Privacy-safe throughout — every exported function returns hashes or counts; no raw command text, paths, URLs, or tool input leaks.
- Correct false-positive rejection — filenames/args containing `test`/`check`/`build` (`cat test.ts`, `npm install test-utils`) correctly return `"execute"`, not `"verify"`.
- `stripQuotedContent` is robust — fenced blocks, blockquotes, inline backticks, double/single/Unicode quotes all stripped; quoted `"no"` and `` `echo no` `` correctly do not trigger corrections.
- Recovery detection is precise — enforces same operation fingerprint AND materially different input, within two non-inspection calls.
- "Verification before mutation does not close a workflow" holds — `workflowRecords` only counts verifications with `mutationIndex >= 0`.
- Capping is correctly deferred to `scoreReviewCandidate`; `deriveTriggerFeatures` returns uncapped counts.
- Robust edge-case handling — null/undefined, circular references, depth limits, non-string inputs all degrade gracefully.
- Deterministic and dependency-free — only imports `node:crypto`; stable serialization (sorted keys) for deterministic hashes.

---

## Verification performed

- `node --check plugins/opencode-learning/index.ts` — OK
- `node --check plugins/opencode-learning/scoring.ts` — OK
- Task 1 Step 7 scenarios (correction detection + eligibility) — PASS
- Task 6 Step 2 deterministic scenarios (8 assertions) — PASS
- Grep confirmed `index.ts` has zero imports from `scoring.ts` and still uses `CORRECTION_RE`, `VERIFY_RE`, `scoreExperience`, `hasLearningSignal`, `isReviewCandidate`.

## Bottom line

`scoring.ts` is a high-quality, nearly-spec-complete pure module with one Important spec deviation (verification command families) and two Minor issues. However, the broader plan is ~15% complete: `index.ts` integration (Tasks 2–4), documentation (Task 5), and end-to-end verification (Task 6) are essentially unstarted. The new scoring module is currently dead code — the plugin still runs the old V1 algorithm. The README `scoreThreshold` default and scoring table are now inconsistent with the plan's intent.
