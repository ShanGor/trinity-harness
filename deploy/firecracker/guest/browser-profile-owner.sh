#!/usr/bin/env bash
set -euo pipefail
profile=/var/lib/trinity/browser
[[ -d "$profile" && ! -L "$profile" ]] || exit 1
/usr/bin/mountpoint -q "$profile" || exit 1
# A profile hard link could also name a workspace file. Refuse migration
# instead of changing ownership through such an alias.
[[ -z "$(/usr/bin/find -P "$profile" -xdev -type f -links +1 -print -quit)" ]] || exit 1
# Never follow profile symlinks or cross into another mounted filesystem.
/usr/bin/find -P "$profile" -xdev -exec /usr/bin/chown -h 1001:1001 -- {} +
