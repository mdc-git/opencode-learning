# OpenCode procedural learning

`opencode-learning` is an Effect-native OpenCode V2 plugin that extracts one reusable procedural skill from root-session activity and stages every learned change for explicit approval.

The plugin ID is `github.learning_skills`. The package root exports the server plugin and `./tui` exports the terminal integration.

## Installation

Configure the GitHub plugin in the OpenCode configuration used by the server:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:mdc-git/opencode-learning"]
}
```

OpenCode loads the package's `./tui` entrypoint for the connected terminal, so the server workflow and terminal presentation come from the same package.

## Local development

The repository root is the local plugin entrypoint. `.opencode/opencode.jsonc` disables the configured GitHub copy and loads the repository root:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["-github.learning_skills", "./"]
}
```

Run OpenCode from the repository root after installing dependencies. The active server plugin keeps the canonical `github.learning_skills` ID regardless of source.

## Learning loop

Automatic review runs after every three successful primary root turns. Each automatic review includes those fresh turns plus up to two preceding turns as overlapping context. The plugin keeps cadence state only in memory. Child sessions and transient reviewer generation do not count as primary turns.

Review evidence marks the boundary between overlapping context and fresh evidence. A create or patch must be materially supported by fresh evidence; context may complete or strengthen that support but cannot justify a proposal by itself. Packet bounding drops older overlapping context before candidate material and never drops fresh evidence.

A review builds bounded evidence, selects up to five plugin-owned project skill candidates using explicit references and token overlap, and performs two transient model calls:

```text
3 successful primary root turns
  + up to 2 preceding turns of context
  -> reviewer
  -> deterministic materialization
  -> validator
  -> pending proposal
  -> explicit /learn-approve
  -> project skill
  -> native skill reload
```

The reviewer and validator use the root session's selected model. Each transient generation removes tools and ambient system context. The validator receives the exact proposed artifact and the evidence used for review. A rejected or empty review consumes the fresh review interval; overlapping context may be reconsidered only when later fresh evidence materially supports a procedure.

Manual `/learn` runs the same review pipeline synchronously over the current root session and treats the captured session evidence as fresh.

## Terminal interaction

The TUI plugin owns all learning presentation. It subscribes to the server plugin's typed RPC activity event and shows native toasts for reviewer start/result, validator start/result, pending-limit notices, and newly staged proposals.

All learning commands require an open root session:

- `/learn` — run a synchronous review of the current root session.
- `/learn-pending [id]` — open the pending proposal selector or inspect one exact proposal UUID.
- `/learn-approve <id>` — apply one exact pending proposal to the project skill tree and reload skills.
- `/learn-reject <id>` — remove one exact pending proposal directory.
- `/learn-promote <skill-id>` — replace the global copy of one plugin-owned project skill and reload skills.

`/learn-pending` shows pending proposals as a selectable list. Selecting a proposal opens its metadata, stale status, file changes, manifest, evidence, and staged `SKILL.md` in a detail dialog.

The terminal calls the server through the connected OpenCode client, so server-owned state and actions remain correct when the TUI and server run on different machines.

## Filesystem state

Project skills are ordinary OpenCode directory skills under:

```text
<project>/.opencode/skills/<skill-id>/
```

Learning state is project-wide filesystem state:

```text
<project>/.opencode/.learning/
  pending/<uuid>/
    proposal.json
    skill/
      SKILL.md
      ...
  tmp/<uuid>/
```

Pending proposals are capped at 20 direct UUID-shaped directories on a best-effort basis across processes. Temporary review directories are owned by the active review that created them.

Global promotion targets `${XDG_CONFIG_HOME}/opencode/skills` when `XDG_CONFIG_HOME` is nonempty, otherwise `${HOME}/.config/opencode/skills`.

## Learned skill contract

A learned project skill ID matches:

```text
^[a-z0-9]+(-[a-z0-9]+)*$
```

Plugin-owned skills carry this frontmatter metadata:

```yaml
metadata:
  opencode-learning/owner: 'true'
```

A valid skill tree contains a valid `SKILL.md`, real directories and regular files only, no symlinks, no file larger than 25 MiB, and no more than 100 MiB total. Reviewer-generated supporting files are limited to 1 MiB each and 10 MiB generated content total.

Patch proposals represent the complete desired skill directory. Their whole-tree revision covers each sorted relative path, executable bit, and exact file bytes. Approval refuses a patch when the current project skill no longer matches its expected revision.

## Approval and promotion

Approval treats the staged `skill/` directory as authoritative, so regular files and executable bits may be edited before approval. The ownership marker must still be present. File replacements use temporary-file rename where appropriate; removed files are deleted last. The pending proposal is consumed only after project and staged post-checks confirm the intended revision.

Promotion validates the plugin-owned project source, replaces the exact global skill directory, copies the complete tree, verifies both source and destination revisions, and reloads native skills.

## Verification

Run the repository verification chain with fresh output:

```sh
npm install
npm run format
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run check:deps
npm run check:knip
npm run audit
npm pack --dry-run
```

The integration test launches and terminates its own isolated private `opencode2 serve --stdio --port 0` child process. It does not stop or restart the user's OpenCode service.
