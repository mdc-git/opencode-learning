# OpenCode procedural learning

This OpenCode V2 plugin extracts reusable procedures from completed sessions
and stores them as native OpenCode skills.

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

### Preserve a package-manager workaround

A session discovers that installing an npm dist-tag resolves the correct
package but rewrites the requested manifest value. The agent restores the
literal tag and verifies the installed package. After the turn, the plugin can
stage a skill containing the exact edit and verification sequence:

```text
session finds and fixes npm manifest normalization
  -> reflector extracts the reusable procedure
  -> validator checks it against recorded tool evidence
  -> /learn-show displays the proposed skill
  -> /learn-approve publishes it to .opencode/skills/
```

### Capture a project deployment sequence

A deployment only succeeds after files are copied in a particular order, a
service is restarted, and an API health check is run. The plugin can propose a
project skill that records those steps and the failure conditions observed in
the session. Future agents can activate that skill before deploying the same
project.

### Improve an existing learned skill

If a later session finds a safer or shorter procedure, the reflector can
propose a section-level patch instead of creating a duplicate skill. The patch
includes the current SHA-256, so approval fails if the skill changed after the
proposal was created.

Use `/learn` when a short session contains valuable knowledge but does not meet
the automatic score threshold. Use `/learn-pending` to review all staged
changes before accepting or rejecting them.

## Requirements

- OpenCode V2
- Node.js and npm on `PATH`
- `@opencode-ai/plugin@next` installed under the selected OpenCode config root

## Install

Clone the repository and enter it:

```sh
git clone https://github.com/mdc-git/opencode-learning.git
cd opencode-learning
```

Choose one installation scope before continuing.

### Global

Use this option to load the plugin, agents, and commands in every OpenCode
project for the current user:

```sh
TARGET="$HOME/.config/opencode"
```

### Project-local

Use this option to load the plugin, agents, and commands only in one project.
Replace `/path/to/project` with that project's root directory:

```sh
TARGET="/path/to/project/.opencode"
```

The remaining installation steps are identical for both scopes and use the
selected `TARGET` value.

Back up an existing target before replacing files with the same names:

```sh
if [ -d "$TARGET" ]; then cp -a "$TARGET" "$TARGET.backup"; fi
```

Install the plugin, agents, commands, and dependency:

```sh
mkdir -p "$TARGET/agents" "$TARGET/commands" "$TARGET/plugins/opencode-learning"
cp agents/*.md "$TARGET/agents/"
cp commands/*.md "$TARGET/commands/"
cp plugins/opencode-learning/index.ts "$TARGET/plugins/opencode-learning/"
cd "$TARGET"
npm install @opencode-ai/plugin@next
```

The resulting layout is:

```text
<target>/
|-- agents/
|   |-- learning-reflector.md
|   `-- learning-validator.md
|-- commands/
|   `-- learn*.md
|-- plugins/
|   `-- opencode-learning/
|       `-- index.ts
`-- node_modules/
```

## Configure

Merge the following into `<target>/opencode.json` or
`<target>/opencode.jsonc`. Keep unrelated settings.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "learning_submit_proposal", "resource": "*", "effect": "deny" },
    { "action": "learning_submit_validation", "resource": "*", "effect": "deny" },
    { "action": "learning_promote", "resource": "*", "effect": "ask" }
  ],
  "plugins": [
    {
      "package": "./plugins/opencode-learning/index.ts",
      "options": {
        "mode": "suggest",
        "scoreThreshold": 10,
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

The two deny rules reserve the structured callback tools for the hidden
reflector and validator agents. Global promotion requires confirmation.

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

The plugin records user corrections and non-learning tool activity. At the end
of a session execution, it scores the completed experience. Work below the
configured threshold is discarded. A qualifying experience follows this flow:

```text
completed project session
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

Automatic review starts when the accumulated score reaches `scoreThreshold`.
The score is calculated from the completed foreground session:

| Signal | Points |
| --- | --- |
| Each tool call | 1 |
| Each failed tool call | 3 additional |
| Recovery after a failed call | 5 |
| User correction | 8 |
| Activated skill | 2 |
| Verification step | 2 |

`/learn` forces the review and bypasses this threshold.

### Architecture and lifecycle

The plugin uses V2 session context hooks to record the conversation tail and
tool hooks to record tool outcomes. It resolves each foreground session through
`ctx.session.get()`, so project paths come from the session location rather than
the service process directory.

Reflector and validator work runs in dedicated sessions with restricted
structured callback tools. Their output is checked before any write. Internal
sessions are interrupted after completion or timeout. Skill changes use the
native skill reload capability, so accepted changes become available without a
service restart.

Automatic completion detection uses the public event stream. That stream is
volatile by contract, so disconnected events are not replayed. `/learn` marks
the current session for review when its next terminal event is observed.

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
| `scoreThreshold` | `10` | Minimum score for automatic review. `/learn` bypasses it. |
| `reviewerTimeoutMs` | `120000` | Timeout for each reflector or validator session. |
| `maxEventsPerSession` | `120` | Maximum retained tool events per foreground session. |
| `maxCandidates` | `5` | Maximum skill candidates sent to the reflector. |
| `confidenceThreshold` | `0.72` | Minimum proposal confidence. |
| `agentValidation` | `true` | Run the hidden validator. |
| `notify` | `true` | Add synthetic session notices. |
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

Set `TARGET` to the same global or project-local directory used during
installation. Remove the plugin path and three learning permission rules from
`$TARGET/opencode.json(c)`, then remove the installed files:

```sh
rm -r "$TARGET/plugins/opencode-learning"
rm "$TARGET/agents/learning-reflector.md"
rm "$TARGET/agents/learning-validator.md"
rm "$TARGET"/commands/learn*.md
opencode2 service restart
```

This leaves learned skills, runtime state, archives, and promoted global skills
untouched.
