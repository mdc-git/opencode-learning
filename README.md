# OpenCode procedural learning

This OpenCode V2 plugin extracts reusable procedures from completed sessions
and stores them as native OpenCode skills.

<!-- markdownlint-disable-next-line MD033 -->
<video controls src="https://github.com/user-attachments/assets/e323399e-8978-4eab-b73b-1d0c442c5cd8"></video>

Install it globally to use it in every project, or install it under one
project's `.opencode` directory. Runtime state and learned skills remain local
to each project in both cases.

## Why use it

OpenCode sessions often uncover procedures that are useful again: a package
manager quirk, a reliable debugging sequence, a project-specific deployment
step, or a verification command that caught a bad change. This plugin turns
that completed work into reviewable OpenCode skills instead of leaving it only
in the session history.

It is designed for procedural knowledge, not session summaries. A proposal must
identify reusable steps, cite evidence from the completed work, pass
deterministic checks, and optionally pass a second agent review. The default
mode stages the result without changing the skill registry.

## Example workflows

### Run the right checks before a pull request

A repository may require more than its obvious test command. During a feature
session, OpenCode learns that generated files must be refreshed first, type
checking must run from a package subdirectory, and one targeted integration
command catches failures the root test script misses. The plugin can preserve
that verified sequence for future changes in the repository.

### Diagnose a flaky test

A test fails intermittently because it depends on stale fixtures, an existing
development server, or a specific environment variable. OpenCode tries several
approaches, identifies the actual precondition, and confirms the reliable
reproduction and cleanup steps. The resulting skill can guide the next agent
straight to the useful diagnostic sequence.

### Follow repository conventions

A user corrects OpenCode for editing generated output instead of its source,
placing a component in the wrong package, or using a library the project has
intentionally avoided. The plugin can turn the correction and the successful
follow-up into a project skill that records where changes belong and how they
should be verified.

### Upgrade a dependency safely

A dependency upgrade needs a configuration rename, regenerated artifacts, and
a focused smoke test in addition to changing the version. Once OpenCode
completes and verifies the upgrade, the plugin can preserve the repository's
upgrade procedure for the next release.

### Recover a local development environment

The application stops starting after a branch switch because cached build
output, containers, or generated clients are stale. OpenCode finds the minimum
cleanup and restart sequence and verifies the health endpoint. That sequence
can become a reusable troubleshooting skill instead of being rediscovered the
next time the environment breaks.

### Refine a procedure over time

If a later session finds that an existing learned procedure is incomplete or
outdated, the plugin can stage a focused patch rather than creating a duplicate
skill. Approval fails when the original skill changed after the patch was
proposed.

Use `/learn` when a short session contains valuable knowledge but does not meet
the automatic score or signal requirements. Use `/learn-pending` to review all
staged changes before accepting or rejecting them.

## Requirements

- OpenCode V2

## Install

Add the plugin to your `opencode.json(c)` and let OpenCode install it
automatically from git. No manual cloning or dependency management is needed.

For global use, edit `~/.config/opencode/opencode.json(c)`. For a single
project, edit `<project>/.opencode/opencode.json(c)` or
`<project>/opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "learning_promote", "resource": "*", "effect": "ask" }
  ],
  "plugins": [
    {
      "package": "opencode-learning@git+https://github.com/mdc-git/opencode-learning.git",
      "options": {
        "mode": "suggest",
        "scoreThreshold": 10,
        "maxAutomaticReviewsPerSession": 1,
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

The plugin denies the callback tools to every configured agent, then allows
each callback only for its matching hidden agent. Do not add global deny rules
for these callbacks, because V2 global denies also block the matching agent.
It also assigns an `ask` policy to the separate `learning_apply` action. Global
promotion uses the configured `learning_promote` `ask` rule.

Restart the service after adding the entry:

```sh
opencode2 service restart
```

OpenCode fetches the repository, resolves `@opencode-ai/plugin` and other
declared dependencies into an isolated cache, and loads the plugin. See
[Verify](#verify) below to confirm it loaded.

> [!NOTE]
> If the plugin fails to load with an `NpmInstallFailedError` about a missing
> `package.json`, a stale npm or OpenCode package cache may be referencing a
> prior failed clone. Clear both caches and restart:
>
> ```sh
> rm -rf ~/.cache/opencode/packages/opencode-learning@git+https:*
> npm cache clean --force
> opencode2 service restart
> ```

## Verify

Restart the V2 service:

```sh
opencode2 service restart
```

From a project where the plugin should be active, verify that it loaded:

```sh
opencode2 api get "/api/plugin?location[directory]=$(pwd)"
```

The response should contain `learning.skills`. Start OpenCode in that project
and run `/learn-status` to check the agents, commands, paths, pending proposals,
and recent reviews.

For loading failures, inspect the service log:

```sh
grep 'learning.skills\|opencode-learning' ~/.local/share/opencode/log/opencode.log | tail -n 50
```

## Commands

| Command | Action |
| --- | --- |
| `/learn` | Force a review after the current turn. |
| `/learn-pending` | List staged proposals for the current project. |
| `/learn-show <id>` | Show a proposal, validation result, and preview. |
| `/learn-approve <id>` | Apply a staged proposal and reload skills. |
| `/learn-reject <id>` | Remove a staged proposal. |
| `/learn-status` | Show configuration, components, paths, and recent reviews. |
| `/learn-curate` | Run stale and archive maintenance. |
| `/learn-promote <skill-id>` | Copy an owned project skill to the global registry. |

## How it works

The plugin records user corrections and non-learning tool activity only for
root foreground sessions. Experience accumulates across executions until it
reaches the configured score threshold and contains a meaningful learning
signal: a post-response user correction, a recovery, or a multi-step verified
workflow. Automatic review runs only after a successful execution and is
limited to one attempt per session by default. A qualifying experience follows
this flow:

```text
successful foreground execution
  -> deterministic score
  -> hidden reflector agent
  -> structured create, patch, or no-change proposal
  -> deterministic validation
  -> hidden validator agent
  -> staged proposal or automatic project update
```

The default `suggest` mode stages accepted proposals for explicit approval.
`auto` applies validated project changes immediately. Neither mode publishes a
skill globally. Global publication only occurs through `/learn-promote` and its
permission prompt.

The writer only creates new plugin-owned skills or patches existing
plugin-owned skills. Patches require the current SHA-256. Supporting file paths
must stay inside the skill directory, and existing supporting files are not
overwritten.

### Scoring

Automatic review requires both the accumulated score reaching
`scoreThreshold` and a meaningful learning signal. The score is calculated from
the accumulated foreground experience:

| Signal | Points |
| --- | --- |
| Each tool call | 1 |
| Each failed tool call | 3 additional |
| Recovery after a failed call | 5 |
| User correction | 8 |
| Activated skill | 2 |
| Verification step | 2 |

`/learn` forces the review and bypasses the score, signal, terminal-outcome,
and automatic-review-limit checks. Failed and interrupted executions are kept
for a later successful execution or an explicit `/learn`, but do not trigger an
automatic review by themselves.

### Architecture and lifecycle

The plugin uses V2 session context hooks to record the conversation tail and
tool hooks to record tool outcomes. It resolves each root foreground session
through `ctx.session.get()`, so project paths come from the session location
rather than the service process directory. Child sessions and the plugin's
internal reviewer sessions are excluded.

Reflector and validator work runs in dedicated sessions with restricted
structured callback tools. Their output is checked before any write. Internal
sessions are interrupted after completion or timeout. Skill changes use the
native skill reload capability, so accepted changes become available without a
service restart.

Automatic completion detection uses the public event stream. That stream is
volatile by contract, so disconnected events are not replayed. Automatic
reviews are considered on successful terminal events, while `/learn` marks the
current session for review when its next terminal event is observed.

## Project data

Every foreground project has separate storage:

```text
<project>/.opencode/skills/       learned skills
<project>/.opencode/.learning/    proposals, telemetry, archives, curator state
```

Add `.opencode/.learning/` to the project's ignore file if runtime state should
not be committed. Learned skills under `.opencode/skills/` can be reviewed and
committed with the project.

Promotion copies an owned project skill to:

```text
~/.config/opencode/skills/
```

It refuses missing or non-owned skills and does not replace an existing global
skill.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `suggest` | `off`, `suggest`, or `auto`. |
| `scoreThreshold` | `10` | Minimum accumulated score for automatic review; a meaningful signal is also required. `/learn` bypasses it. |
| `reviewerTimeoutMs` | `120000` | Timeout for each reflector or validator session. |
| `maxEventsPerSession` | `120` | Maximum retained tool events per foreground session. |
| `maxAutomaticReviewsPerSession` | `1` | Maximum automatic review attempts per foreground session. `0` disables automatic reviews; `/learn` remains available. |
| `maxCandidates` | `5` | Maximum skill candidates sent to the reflector. |
| `confidenceThreshold` | `0.72` | Minimum proposal confidence. |
| `agentValidation` | `true` | Run the hidden validator. |
| `notify` | `true` | Add synthetic session notices for reviews explicitly started with `/learn`; automatic reviews remain silent. |
| `projectSkillDir` | `.opencode/skills` | Learned-skill path relative to the project root. |
| `stateDir` | `.opencode/.learning` | Runtime-state path relative to the project root. |
| `globalSkillDir` | `~/.config/opencode/skills` | Explicit promotion destination. |
| `reflectorAgent` | `learning-reflector` | Reflector agent ID. |
| `validatorAgent` | `learning-validator` | Validator agent ID. |
| `curator.enabled` | `true` | Enable stale and archive maintenance. |
| `curator.checkEveryHours` | `24` | Minimum interval between curator runs. |
| `curator.staleAfterDays` | `30` | Mark inactive owned skills as stale. |
| `curator.archiveAfterDays` | `90` | Move inactive owned skills to the archive. |

## Remove

Remove the plugin entry and three learning permission rules from your
`opencode.json(c)`, then restart:

```sh
opencode2 service restart
```

This leaves learned skills, runtime state, archives, and promoted global skills
untouched.
