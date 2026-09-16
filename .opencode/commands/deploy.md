---
description: Update the global Git package and verify plugin activation
---

!`set -eu; package='opencode-learning@git+https://github.com/mdc-git/opencode-learning.git'; printf 'Checking package updates: %s\n' "$package"; opencode2 plugin check "$package"; printf 'Updating package: %s\n' "$package"; opencode2 plugin update "$package"; printf 'Package update completed. Poll /api/plugin at the target location until the expected package revision reports an active state.'`
