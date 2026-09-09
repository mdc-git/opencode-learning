# OpenCode procedural learning

OpenCode procedural learning is a V2 plugin that turns reusable procedures from completed sessions into native OpenCode skills.

<!-- markdownlint-disable-next-line MD033 -->

<video controls src="https://github.com/user-attachments/assets/e323399e-8978-4eab-b73b-1d0c442c5cd8"></video>

Install it globally to make it available in every project, or install it under one project's `.opencode` directory. In both cases, runtime state and learned skills remain local to each project.

## Why use it

OpenCode sessions often uncover procedures worth keeping: a package-manager quirk, a reliable debugging sequence, a project-specific deployment step, or a verification command that catches a bad change. This plugin turns that completed work into reviewable OpenCode skills instead of leaving it only in session history.

It captures procedural knowledge rather than session summaries. A proposal must identify reusable steps, cite evidence from completed work, pass deterministic checks, and optionally pass a second agent review. The default mode stages the result for review without changing the skill registry.

## Example workflows

### Run the right checks before a pull request

A repository may need more than its obvious test command. A feature session can reveal that generated files must be refreshed first, type checking must run from a package subdirectory, and one targeted integration command catches failures the root test script misses. The plugin can preserve that verified sequence for future changes.

### Diagnose a flaky test

A test may fail intermittently because of stale fixtures, an existing development server, or a required environment variable. OpenCode can try several approaches, identify the actual precondition, and confirm the reliable reproduction and cleanup steps. The resulting skill can guide a later session directly to that diagnostic sequence.

### Follow repository conventions

A user may correct OpenCode for editing generated output instead of its source, placing a component in the wrong package, or choosing a library the project intentionally avoids. The plugin can turn the correction and successful follow-up into a project skill that records where changes belong and how to verify them.

### Upgrade a dependency safely

A dependency upgrade may require a configuration rename, regenerated artifacts, and a focused smoke test in addition to changing the version. After OpenCode completes and verifies the upgrade, the plugin can preserve the repository's upgrade procedure for the next release.

### Recover a local development environment

A branch switch may leave cached build output, containers, or generated clients stale. OpenCode can find the minimum cleanup and restart sequence, verify the health endpoint, and preserve that troubleshooting procedure for later use.

### Refine a procedure over time

If a later session finds an existing learned procedure incomplete or outdated, the plugin can stage a focused patch instead of creating a duplicate skill. Approval fails if the original skill changed after the patch was proposed.

Use `/learn` when a short session contains useful procedural knowledge but does not meet the automatic score or signal requirements. Use `/learn-pending` to review all staged changes before accepting or rejecting them.

## Requirements

- OpenCode V2
- Node.js 20 or newer for local dependency checks

## Install

Add the plugin to your `opencode.json(c)` and let OpenCode install it from git. No manual clone or dependency setup is required.

For global use, edit `${HOME}/.config/opencode/opencode.json(c)`. For one project, edit `<project>/.opencode/opencode.json(c)` or `<project>/opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [{ "action": "learning_promote", "resource": "*", "effect": "ask" }],
  "plugins": [
    {
      "package": "opencode-learning@git+https://github.com/mdc-git/opencode-learning.git",
      "options": {
        "mode": "suggest",
        "scoreThreshold": 12,
        "workflowCooldownTurns": 3,
        "confidenceThreshold": 0.72,
        "agentValidation": true,
        "notify": true,
        "projectSkillDir": ".opencode/skills",
        "stateDir": ".opencode/.learning",
        "reflectorAgent": "learning-reflector",
        "validatorAgent": "learning-validator",
        "curator": {
          "enabled": true,
          "checkEveryHours": 24,
          "staleAfterDays": 30,
          "archiveAfterDays": 90
        }
      }
    }
  ]
}
```

The plugin denies its callback tools to every configured agent, then allows each callback only for the matching hidden agent. Do not add global deny rules for these callbacks because V2 global denies also block the matching agent.

The plugin also assigns an `ask` policy to the separate `learning_apply` action. Global promotion uses the configured `learning_promote` `ask` rule.

Restart the service after adding the plugin:

```sh
opencode2 service restart
```

OpenCode fetches the repository, resolves `@opencode-ai/plugin` and the other declared dependencies into an isolated cache, then loads the plugin. See [Verify](#verify) to confirm that it is active.

> [!NOTE]
> The native `opencode2 plugin update` command refreshes the configured package and notifies active locations to reload it. The local development override below does not use the package cache. If a deployed package reports an install error, inspect the service log and plugin state.

## Local development

The repository includes a tracked local V2 harness under `.opencode/`:

- `opencode.jsonc` removes the globally deployed `github.learning_skills` plugin.
- `.opencode/plugins/learning/index.ts` loads the checkout entrypoint and assigns the local `local.learning_skills` ID.
- The server plugin advertises and ships a TUI addon for staged-proposal notifications.
- `.opencode/plugins/learning/tui.tsx` assigns the local TUI addon ID.
- `.opencode/cli.json` is only for an intentionally isolated config directory. The normal workflow keeps the global CLI configuration active.

Run the private server and TUI from the repository root:

```sh
npm install
opencode2 --standalone
```

Do not set `OPENCODE_CONFIG_DIR` for the normal checkout workflow. OpenCode uses the global configuration as its base and merges the project `.opencode/opencode.jsonc` on top. The removal entry prevents the deployed plugin and local wrapper from registering the same plugin ID.

## Verify

Restart the V2 service:

```sh
opencode2 service restart
```

From a project where the plugin should be active, check the loaded plugins:

```sh
opencode2 api get "/api/plugin?location[directory]=$(pwd)"
```

A deployed package should appear as `github.learning_skills`. When OpenCode runs from this checkout, it should instead appear as `local.learning_skills` with a local source.

Start OpenCode in that project and run `/learn-status` to inspect the agents, commands, paths, pending proposals, and recent reviews.

For loading failures, inspect the service log:

```sh
grep 'learning_skills\|opencode-learning' ${HOME}/.local/share/opencode/log/opencode.log | tail -n 50
```

## Git deployment

The global Git installation uses the package export, not the project-local `.opencode/` harness. After changing source or package metadata:

1. Run the developer checks below.
2. Commit and push the change.
3. Run `/deploy` from this repository. It runs the native targeted `opencode2 plugin check` and `opencode2 plugin update` commands.
4. Verify the target location with `POST /api/plugin/await-activation`, then inspect `GET /api/plugin` for the active package revision.

The native updater refreshes the package and notifies active locations to reload it. Do not delete package caches manually or use service status as a plugin-readiness check.

## Developer checks

```sh
npm install
npm run lint
npm run format:check
npm run typecheck
npm run check:deps
npm run check:knip
```

## Commands

| Command                     | Action                                                                       |
| --------------------------- | ---------------------------------------------------------------------------- |
| `/learn`                    | Force a review after the current turn.                                       |
| `/learn-pending`            | List staged proposals for the current project.                               |
| `/learn-show <id>`          | Show a proposal, validation result, and preview.                             |
| `/learn-approve <id>`       | Apply a staged proposal and reload skills.                                   |
| `/learn-reject <id>`        | Remove a staged proposal.                                                    |
| `/learn-status`             | Show configuration, components, paths, trigger counters, and recent reviews. |
| `/learn-curate`             | Run stale and archive maintenance.                                           |
| `/learn-promote <skill-id>` | Copy an owned project skill to the global registry.                          |

## How it works

The plugin records user corrections and non-learning tool activity only for root foreground sessions. Evidence accumulates across executions until it both reaches the configured score threshold and contains a qualifying learning signal.

Automatic review runs only after a successful execution. Each review consumes its evidence batch, so another automatic review requires fresh learning signals.

A qualifying batch follows this flow:

```text
successful foreground execution
  -> deterministic score
  -> hidden reflector agent
  -> structured create, patch, or no-change proposal
  -> deterministic validation
  -> hidden validator agent
  -> staged proposal or automatic project update
```

The default `suggest` mode stages accepted proposals for explicit approval. `auto` applies validated project changes immediately. Neither mode publishes skills globally. Global publication only occurs through `/learn-promote` and its permission prompt.

The writer creates only new plugin-owned skills or patches existing plugin-owned skills. Patches require the current SHA-256. Supporting file paths must stay inside the skill directory, and existing supporting files are not overwritten.

### Scoring

Automatic review requires both conditions below:

- the accumulated score reaches `scoreThreshold`;
- at least one strong closed-loop signal is present: an incorporated correction, a confirmed recovery, or a repeated verified workflow.

The score uses capped closed-loop features rather than raw activity volume:

```text
C = min(incorporated corrections, 1)
R = min(confirmed recoveries, 2)
W = min(repeated verified workflows, 1)
V = min(successful verifications after mutation, 2)
F = min(unresolved failures, 2)
D = min(distinct tool categories, 3)

score = 12*C + 8*R + 8*W + 2*V + 1*F + 1*D
```

With the default configuration, automatic review triggers at `score >= 12` and still requires at least one correction, recovery, or verified-workflow signal. Raw tool calls, skill loads, failed checks, and keyword matches do not earn points by themselves; they remain available as reflector evidence.

`/learn` forces a review and bypasses the score, signal, cadence, and duplicate-suppression checks. Failed and interrupted executions are retained for a later successful execution or an explicit `/learn`, but they do not trigger automatic review by themselves.

#### Closed-loop signals

The trigger is deterministic plugin code. The reflector and validator agents run only after an evidence batch qualifies.

- **Explicit correction -> changed action -> successful completion.** A user follows up with "No, patch the source file instead." The next successful turn contains a successful edit of the source file.
- **Failed operation -> materially changed equivalent retry -> success.** A shell `npm test` run errors, then the same operation retried with a corrected command succeeds within the next two non-inspection calls.
- **Mutation -> recognized successful verification, repeated on another successful turn.** A turn succeeds after a successful edit followed by a successful `npm test`, and the same category/operation sequence recurs in another successful turn.

#### Cadence and suppression

- Workflow-only candidates with no correction or recovery wait for three successful turns after the previous automatic review before another review.
- Evidence continues to accumulate while a candidate waits, so new signals merge into the deferred batch.
- Correction and recovery candidates bypass the workflow cadence gate.
- Equivalent accepted or no-change fingerprints are not reviewed repeatedly in the same session. A later candidate with the same fingerprint is retained but not reflected until a new correction or recovery changes the fingerprint.
- Each review consumes its evidence batch, so later reviews require fresh learning signals.

### Architecture and lifecycle

The plugin uses V2 session context hooks to record the conversation tail and tool hooks to record tool outcomes. It resolves each root foreground session through `ctx.session.get()`, so project paths come from the session location rather than the service process directory. Child sessions and the plugin's internal reviewer sessions are excluded.

Reflector and validator work runs in dedicated sessions with restricted structured callback tools. Their output is checked before any write.

The TUI addon removes marked reviewer sessions after every terminal outcome and sweeps inactive marked reviewer sessions at startup. Without a TUI, those sessions remain durable. Accepted skill changes use the native skill reload capability, so they become available without a service restart.

Automatic completion detection uses the public event stream. That stream is volatile by contract, so disconnected events are not replayed. Automatic reviews are considered on successful terminal events. `/learn` marks the current session for review when its next terminal event is observed.

## Project data

Each foreground project has separate storage:

```text
<project>/.opencode/skills/       learned skills
<project>/.opencode/.learning/    proposals, telemetry, archives, curator state
```

Add `.opencode/.learning/` to the project's ignore file if runtime state should not be committed. Learned skills under `.opencode/skills/` can be reviewed and committed with the project.

Promotion copies an owned project skill to:

```text
${HOME}/.config/opencode/skills/
```

It refuses missing or non-owned skills and does not replace an existing global skill.

## Options

| Option                     | Default                     | Meaning                                                                                                                                                   |
| -------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                     | `suggest`                   | `off`, `suggest`, or `auto`.                                                                                                                              |
| `scoreThreshold`           | `12`                        | Minimum V2 closed-loop score for automatic review; at least one correction, recovery, or verified-workflow signal is also required. `/learn` bypasses it. |
| `workflowCooldownTurns`    | `3`                         | Successful turns to wait before re-reviewing a workflow-only candidate.                                                                                   |
| `reviewerTimeoutMs`        | `120000`                    | Timeout for each reflector or validator session.                                                                                                          |
| `maxEventsPerSession`      | `120`                       | Maximum retained tool events per foreground session.                                                                                                      |
| `maxCandidates`            | `5`                         | Maximum skill candidates sent to the reflector.                                                                                                           |
| `confidenceThreshold`      | `0.72`                      | Minimum proposal confidence.                                                                                                                              |
| `agentValidation`          | `true`                      | Run the hidden validator.                                                                                                                                 |
| `notify`                   | `true`                      | Add synthetic session notices and TUI toast notifications when a proposal is staged.                                                                      |
| `projectSkillDir`          | `.opencode/skills`          | Learned-skill path relative to the project root.                                                                                                          |
| `stateDir`                 | `.opencode/.learning`       | Runtime-state path relative to the project root.                                                                                                          |
| `globalSkillDir`           | `~/.config/opencode/skills` | Explicit promotion destination.                                                                                                                           |
| `reflectorAgent`           | `learning-reflector`        | Reflector agent ID.                                                                                                                                       |
| `validatorAgent`           | `learning-validator`        | Validator agent ID.                                                                                                                                       |
| `curator.enabled`          | `true`                      | Enable stale and archive maintenance.                                                                                                                     |
| `curator.checkEveryHours`  | `24`                        | Minimum interval between curator runs.                                                                                                                    |
| `curator.staleAfterDays`   | `30`                        | Mark inactive owned skills as stale.                                                                                                                      |
| `curator.archiveAfterDays` | `90`                        | Move inactive owned skills to the archive.                                                                                                                |

## Remove

Remove the plugin entry and three learning permission rules from your `opencode.json(c)`, then restart the service:

```sh
opencode2 service restart
```

This leaves learned skills, runtime state, archives, and promoted global skills untouched.
