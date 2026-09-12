# OpenCode Learning

An OpenCode V2 plugin that turns useful patterns from your sessions into reusable
project skills.

It reviews successful work, identifies reusable procedures, validates the
proposal, and waits for explicit approval before adding anything to your project.

## Features

- Learns from normal OpenCode sessions
- Reviews automatically after every three successful primary root turns
- Supports manual review with `/learn`
- Prioritizes explicit corrections, verified fixes, and reusable workflows
- Stages every learned skill for approval before applying it
- Lets you inspect, approve, reject, and promote learned skills
- Stores learned skills as normal OpenCode skills

## Installation

Add the plugin to your OpenCode configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-learning@git+https://github.com/mdc-git/opencode-learning.git"
    }
  ]
}
```

## Quick start

Use OpenCode normally. The plugin periodically reviews successful root-session
work and stages a proposal when it finds a reusable procedure.

Nothing is applied automatically.

To run a review immediately:

```text
/learn
```

Inspect pending proposals:

```text
/learn-pending
```

Approve a proposal:

```text
/learn-approve <id>
```

The approved skill is written to:

```text
<project>/.opencode/skills/<skill-id>/
```

## How it works

```text
session work
  ↓
review
  ↓
validation
  ↓
pending proposal
  ↓
explicit approval
  ↓
.opencode/skills/<skill-id>/
```

The reviewer looks for procedures that are useful beyond the immediate task,
especially:

1. explicit user corrections;
2. failures followed by a correction and verified result;
3. non-obvious successful workflows worth reusing.

A proposal must be supported by evidence from the session. Existing context can
help explain that evidence, but it cannot justify a learned instruction by
itself.

The validator checks the proposed skill before it becomes pending. Approval is
still always explicit.

## Commands

| Command | Purpose |
| --- | --- |
| `/learn` | Review the current root session now |
| `/learn-pending [id]` | List pending proposals or inspect one proposal |
| `/learn-approve <id>` | Apply a pending proposal to the project skill tree |
| `/learn-reject <id>` | Discard a pending proposal |
| `/learn-promote <skill-id>` | Promote a plugin-owned project skill to the global skill directory |

`/learn-pending` opens a selector when no proposal ID is provided. Selecting a
proposal shows its staged skill and supporting details before you decide whether
to approve it.

## Project and global skills

Approved skills are ordinary OpenCode directory skills:

```text
<project>/.opencode/skills/<skill-id>/
```

Promoted skills are copied to the global OpenCode skill directory:

```text
${XDG_CONFIG_HOME}/opencode/skills
```

or, when `XDG_CONFIG_HOME` is not set:

```text
${HOME}/.config/opencode/skills
```

Only skills owned by `opencode-learning` can be promoted with
`/learn-promote`.

## Requirements

- OpenCode V2
- Node.js 24 or newer
- `flock` from `util-linux`

## Development

Install dependencies:

```sh
bun install --frozen-lockfile
```

Run repository checks:

```sh
bun run check
```

Apply supported fixes and rerun validation:

```sh
bun run fix
```

When OpenCode is started from the repository checkout, the local `.opencode`
wrapper loads the checkout version instead of the deployed plugin.
