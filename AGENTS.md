# Repository instructions

This package targets the current OpenCode V2 Effect plugin API. Use `@opencode/plugin` on the `beta` channel and pin the compatible Effect release used by that channel. Verify current OpenCode V2 documentation and published package metadata before changing OpenCode integration behavior.

Keep the server plugin Effect-native. Use native OpenCode session, command, event, skill, and catalog facilities directly. Keep lint rules authoritative and preserve the package-root local/GitHub deployment model defined by `package.json` and `.opencode/opencode.jsonc`.
