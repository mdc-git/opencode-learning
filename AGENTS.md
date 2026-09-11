# Repository instructions

This package targets the current OpenCode V2 Effect plugin API. Use `@opencode/plugin` on the `beta` channel and pin the compatible Effect release used by that channel. Verify current OpenCode V2 documentation and published package metadata before changing OpenCode integration behavior.

Keep the server plugin Effect-native. Use native OpenCode session, command, event, skill, and catalog facilities directly. Keep lint rules authoritative. Production package exports point directly at `plugins/opencode-learning/`; the tracked `.opencode` directory is the checkout-local plugin package and assigns `local.*` IDs to the server and TUI wrappers.
