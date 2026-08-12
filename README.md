# OpenCode procedural learning

This is a global OpenCode V2 plugin that extracts reusable procedures from
completed sessions and stores them as native OpenCode skills.

The plugin is installed once in the global OpenCode config directory. Learning
state remains separate for each project. A project skill is copied into the
global skill registry only when you run `/learn-promote <skill-id>` and approve
the permission request.

## Package contents

```text
opencode-learning/
|-- agents/
|   |-- learning-reflector.md
|   `-- learning-validator.md
|-- commands/
|   |-- learn.md
|   |-- learn-approve.md
|   |-- learn-curate.md
|   |-- learn-pending.md
|   |-- learn-promote.md
|   |-- learn-reject.md
|   |-- learn-show.md
|   `-- learn-status.md
|-- plugins/
|   `-- opencode-learning/
|       `-- index.ts
|-- opencode.jsonc.example
|-- package.json.example
`-- README.md
```

`plugins/opencode-learning/index.ts` is self-contained apart from its import of
`@opencode-ai/plugin`. The agents and commands stay as separate Markdown files
because OpenCode discovers them natively.

## Before copying

Back up the global OpenCode configuration if it contains files with the same
names:

```sh
cp -a ~/.config/opencode ~/.config/opencode.backup
```

The package does not contain `opencode.json`, `opencode.jsonc`, or
`package.json`, so copying it does not replace those files. It does replace an
older installation of the learning plugin, its two agents, and its eight
commands.

## Clone the repository

```sh
git clone https://github.com/mdc-git/opencode-learning.git
```

## Copy the files

Run this from the directory that contains `opencode-learning`:

```sh
mkdir -p ~/.config/opencode/agents ~/.config/opencode/commands ~/.config/opencode/plugins/opencode-learning
cp ./opencode-learning/agents/*.md ~/.config/opencode/agents/
cp ./opencode-learning/commands/*.md ~/.config/opencode/commands/
cp ./opencode-learning/plugins/opencode-learning/index.ts ~/.config/opencode/plugins/opencode-learning/
```

After copying, the installed files should include:

```text
~/.config/opencode/agents/learning-reflector.md
~/.config/opencode/agents/learning-validator.md
~/.config/opencode/commands/learn.md
~/.config/opencode/commands/learn-approve.md
~/.config/opencode/commands/learn-curate.md
~/.config/opencode/commands/learn-pending.md
~/.config/opencode/commands/learn-promote.md
~/.config/opencode/commands/learn-reject.md
~/.config/opencode/commands/learn-show.md
~/.config/opencode/commands/learn-status.md
~/.config/opencode/plugins/opencode-learning/index.ts
```

## Check the plugin dependency

The TypeScript plugin imports `@opencode-ai/plugin`. OpenCode does not expose
its private runtime copy to local plugin files, so the package must be visible
from `~/.config/opencode/node_modules`.

Check whether the global config already provides it:

```sh
cd ~/.config/opencode
npm ls @opencode-ai/plugin --depth=0
```

If the command reports an installed package, no additional install is needed.
This is commonly already present when another local V2 plugin, such as
`js-repl.ts`, uses the same import.

If it is missing, merge the dependency from `package.json.example` into the
existing `~/.config/opencode/package.json`, then install:

```sh
cd ~/.config/opencode
npm install
```

Do not replace an existing global `package.json` with `package.json.example`.
The example contains only the dependency this plugin needs and uses the
`@opencode-ai/plugin@next` dist-tag.

## Update the OpenCode config

Open `~/.config/opencode/opencode.json` or
`~/.config/opencode/opencode.jsonc` and make two changes.

Add these permission rules to the existing `permissions` array:

```jsonc
{ "action": "learning_submit_proposal", "resource": "*", "effect": "deny" },
{ "action": "learning_submit_validation", "resource": "*", "effect": "deny" },
{ "action": "learning_promote", "resource": "*", "effect": "ask" }
```

The two deny rules prevent ordinary agents from calling the internal callback
tools. The hidden reflector and validator agents contain narrower rules that
allow only their matching callback. The promotion rule requires confirmation
before a project skill is published globally.

Add the plugin path to the existing plugin array. For a config that already
loads `js-repl.ts`, it can look like this:

```jsonc
{
  "plugins": [
    "./plugins/opencode-learning/index.ts"
  ]
}
```

Keep all unrelated config entries. `opencode.jsonc.example` contains a
complete fragment with the permissions and plugin entry, but it is an example
to merge, not a replacement for your global config.

## Configure the plugin

The string entry uses all bundled defaults:

```jsonc
{
  "plugins": [
    "./plugins/opencode-learning/index.ts"
  ]
}
```

Use an object entry to pass options:

```jsonc
{
  "plugins": [
    "./plugins/js-repl.ts",
    {
      "package": "./plugins/opencode-learning/index.ts",
      "options": {
        "mode": "suggest",
        "scoreThreshold": 10,
        "reviewerTimeoutMs": 120000,
        "maxEventsPerSession": 120,
        "maxCandidates": 5,
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
    },
    "opencode-chatgpt-websearch"
  ]
}
```

The plugin accepts these options:

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `suggest` | `off` disables learning, `suggest` stages proposals for approval, and `auto` applies validated project changes immediately. |
| `scoreThreshold` | `10` | Minimum deterministic experience score for an automatic review. `/learn` bypasses this threshold. |
| `reviewerTimeoutMs` | `120000` | Maximum time allowed for each internal reflector or validator session. |
| `maxEventsPerSession` | `120` | Maximum number of tool events retained for one foreground session. |
| `maxCandidates` | `5` | Maximum number of relevant skill candidates supplied to the reflector. |
| `confidenceThreshold` | `0.72` | Minimum proposal confidence accepted by deterministic validation. |
| `agentValidation` | `true` | Runs the independent hidden validator after deterministic validation. |
| `notify` | `true` | Adds synthetic session notices for forced reviews, staged proposals, applied changes, and failures. |
| `projectSkillDir` | `.opencode/skills` | Skill directory relative to each foreground project's root. |
| `stateDir` | `.opencode/.learning` | Runtime state directory relative to each foreground project's root. |
| `globalSkillDir` | `~/.config/opencode/skills` | Destination used only by explicit skill promotion. Set an absolute path when overriding it. |
| `reflectorAgent` | `learning-reflector` | Agent ID used to create internal reflection sessions. |
| `validatorAgent` | `learning-validator` | Agent ID used to create internal validation sessions. |
| `curator.enabled` | `true` | Enables stale and archive maintenance for plugin-owned project skills. |
| `curator.checkEveryHours` | `24` | Minimum interval between automatic curator runs for an active project. |
| `curator.staleAfterDays` | `30` | Marks an inactive plugin-owned project skill as stale. |
| `curator.archiveAfterDays` | `90` | Moves an inactive plugin-owned project skill into the project archive. |

`auto` mode never publishes a skill globally. Automatic proposals are forced to
project scope. Global publication still requires `/learn-promote <skill-id>`
and the `learning_promote` permission prompt.

Paths in `projectSkillDir` and `stateDir` are resolved separately for every
foreground project. Changing either option affects where new state is read and
written; it does not move existing files.

## Restart and verify

Restart the V2 service so loaded project locations receive the new global
plugin:

```sh
opencode2 service restart
```

From a project directory, check the active plugins:

```sh
opencode2 api get "/api/plugin?location[directory]=$(pwd)"
```

The response should contain:

```text
learning.skills
```

Start OpenCode in that project and run:

```text
/learn-status
```

The status output should report both hidden agents, all learning commands, the
current project root, and the project-specific state paths. If the plugin is
missing after editing the config, inspect the server log for a load error:

```sh
grep 'learning.skills\|opencode-learning' ~/.local/share/opencode/log/opencode.log | tail -n 50
```

## How project isolation works

The plugin resolves each foreground session with `ctx.session.get()` and uses
the session's `location.directory` as the project root. Each loaded project gets
its own recorder, pending proposals, telemetry, curator state, and learned
skills:

```text
<project>/.opencode/skills/
<project>/.opencode/.learning/
```

The plugin installation directory is not used as a project root. Sessions from
different projects do not share pending proposals or project telemetry.

Runtime state under `<project>/.opencode/.learning/` contains review records,
pending proposals, curator state, and archived plugin-owned skills. Add that
directory to the project's ignore file if it should not be committed. Learned
skills under `<project>/.opencode/skills/` are not temporary state and can be
reviewed and committed with the project.

## Learning flow

The plugin records user corrections and non-learning tool activity. When the
session execution finishes, it scores the completed experience. Work below the
configured threshold is discarded. A qualifying experience follows this path:

```text
completed project session
  -> deterministic score
  -> hidden reflector agent
  -> structured create, patch, or no-change proposal
  -> deterministic validation
  -> hidden validator agent
  -> staged project proposal
  -> explicit approval or rejection
```

The default mode is `suggest`, so accepted proposals are staged instead of
written immediately. Automatic reflection is restricted to project scope.

The implementation uses the native V2 plugin context for session creation,
prompts, hooks, structured tools, synthetic session messages, and skill reloads.
Reflector and validator results arrive through restricted structured callback
tools; internal sessions are interrupted after success or timeout. The public
event stream is used only to observe foreground session completion, because the
current `@opencode-ai/plugin@next` context does not expose the documented
`session.wait` or session-message APIs. That stream is volatile, so automatic
reviews are best effort; `/learn` explicitly forces the next observed review.

The writer can create a new plugin-owned skill or patch sections of an existing
plugin-owned skill. It refuses to patch unrelated skills, requires the current
SHA-256 for patches, rejects unsafe supporting-file paths, and does not
overwrite existing supporting files.

New skill IDs are canonicalized before validation. Spaces, punctuation, and
camel case are converted to lowercase kebab-case, IDs are limited to 64
characters, and a missing ID is derived from `skill.name`. Patch IDs are never
rewritten because they must identify an exact existing owned skill.

## Commands

| Command | Action |
| --- | --- |
| `/learn` | Force a review of the current completed session. |
| `/learn-pending` | List staged proposals for the current project. |
| `/learn-show <id>` | Show one proposal, its validation, and its preview. |
| `/learn-approve <id>` | Apply one staged project proposal and reload skills. |
| `/learn-reject <id>` | Remove one staged proposal. |
| `/learn-status` | Show config, component discovery, paths, skills, and recent reviews. |
| `/learn-curate` | Run stale and archive maintenance for the current project. |
| `/learn-promote <skill-id>` | Copy one plugin-owned project skill into the global registry. |

## Global promotion

Promotion is the only operation that writes to the global skill directory:

```text
~/.config/opencode/skills/
```

`/learn-promote <skill-id>` resolves the skill from the current project. The
operation refuses a missing skill, a skill not owned by this plugin, or a global
destination that already exists. It reserves the destination before copying
and does not replace an existing global skill.

The global skill becomes available to other projects after the plugin reloads
the skill registry. Later project learning remains project-local unless another
promotion is approved.

## Defaults

The bundled defaults are:

| Setting | Default |
| --- | --- |
| Mode | `suggest` |
| Review score threshold | `10` |
| Proposal confidence threshold | `0.72` |
| Independent agent validation | enabled |
| User notifications | enabled |
| Project skill directory | `.opencode/skills` |
| Project state directory | `.opencode/.learning` |
| Curator check interval | 24 hours |
| Mark stale after | 30 days |
| Archive after | 90 days |

The curator only manages project skills marked as owned by
`opencode-learning`. It moves old skills into the project's learning archive
and never permanently deletes them.

## Remove the plugin

Remove the plugin path and the three learning permission rules from the global
OpenCode config. Then remove the installed runtime, agents, and commands:

```sh
rm -r ~/.config/opencode/plugins/opencode-learning
rm ~/.config/opencode/agents/learning-reflector.md
rm ~/.config/opencode/agents/learning-validator.md
rm ~/.config/opencode/commands/learn*.md
opencode2 service restart
```

This does not remove project skills, project learning state, archives, or
globally promoted skills. Remove those separately only after reviewing them.
