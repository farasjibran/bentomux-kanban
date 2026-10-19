#!/usr/bin/env bash
#
# Publish a plugin version.
#
#   ./publish.sh <version>          e.g. ./publish.sh 1.0.1
#   ./publish.sh <version> <dir>    publish a different plugin folder
#
# What it does, and why each step exists:
#
#   1. validate            a plugin that fails validation still installs fine
#                          and only breaks at runtime, so it must never ship
#   2. version guard       an update is offered by comparing the release tag
#                          against the manifest version. They must agree, or
#                          the same update is offered forever
#   3. zip, files at root  the installer reads plugin.json out of the archive
#                          root. A wrapper directory also works, but build it
#                          explicitly rather than relying on that
#   4. release             gh when it is installed (GitHub computes and
#                          publishes the digest from the upload). Otherwise the
#                          zip in .build/ is what you attach to a GitLab
#                          release by hand
#
set -euo pipefail

VERSION="${1:?usage: publish.sh <version> [plugin-dir]}"
PLUGIN_DIR="${2:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$PLUGIN_DIR" ]; then
  # exactly one plugin folder, if there is only one
  candidates=(*/)
  if [ "${#candidates[@]}" -ne 1 ]; then
    echo "more than one plugin folder; name one explicitly:"
    printf "  %s\n" "${candidates[@]}"
    exit 2
  fi
  PLUGIN_DIR="${candidates[0]}"
fi

case "$PLUGIN_DIR" in
  */) PLUGIN_DIR="${PLUGIN_DIR%/}" ;;
esac

if [ ! -d "$PLUGIN_DIR" ]; then
  echo "no such plugin folder: $PLUGIN_DIR" >&2
  exit 2
fi

# 1. validate --------------------------------------------------------------
VALIDATOR="${BENTOMUX:-$REPO_ROOT/../Bentomux-v2/src-tauri/target/debug/bentomux}"
if [ ! -x "$VALIDATOR" ]; then
  echo "validator not built at $VALIDATOR" >&2
  echo "build it:  cargo build --manifest-path ../Bentomux-v2/src-tauri/Cargo.toml" >&2
  echo "or point BENTOMUX at an installed bentomux binary." >&2
  exit 2
fi

echo "==> validating $PLUGIN_DIR"
"$VALIDATOR" --plugin-validate "$PLUGIN_DIR" || exit $?

# 2. version guard ---------------------------------------------------------
ACTUAL="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$PLUGIN_DIR/plugin.json")"
if [ "$ACTUAL" != "$VERSION" ]; then
  echo "plugin.json says version $ACTUAL but you asked for $VERSION" >&2
  echo "fix plugin.json, or re-run with $ACTUAL." >&2
  exit 1
fi

# 3. zip -------------------------------------------------------------------
ZIP="$REPO_ROOT/.build/$PLUGIN_DIR-$VERSION.zip"
mkdir -p "$(dirname "$ZIP")"
rm -f "$ZIP"

echo "==> zipping $PLUGIN_DIR"
( cd "$PLUGIN_DIR" && zip -qr "$ZIP" . -x '*.DS_Store' '__MACOSX/*' '.git/*' )

# The listing is captured before grepping rather than piped into it: grep -q
# exits the moment it matches, which sends SIGPIPE to unzip, and pipefail
# (above) then reports that as a failed pipeline. It is a race, so piping here
# makes the guard reject good archives at random.
LISTING="$(unzip -l "$ZIP")"
if ! grep -q ' plugin\.json$' <<<"$LISTING"; then
  echo "plugin.json is not at the archive root — check what got zipped:" >&2
  echo "$LISTING" >&2
  exit 1
fi
echo "    $(wc -c <"$ZIP" | tr -d ' ') bytes, $(tail -1 <<<"$LISTING" | awk '{print $2}') files, plugin.json at root"

# 4. release ---------------------------------------------------------------
if command -v gh >/dev/null 2>&1; then
  echo "==> creating GitHub release v$VERSION"
  gh release create "v$VERSION" "$ZIP" \
    --title "$PLUGIN_DIR $VERSION" \
    --notes "$PLUGIN_DIR $VERSION."
else
  echo "==> gh is not installed: attach this zip to a GitLab release"
  echo "    $ZIP"
  echo "    sha256 $(shasum -a 256 "$ZIP" | awk '{print $1}')"
fi

cat <<TIP

Published $VERSION.

  - install it from Settings → Plugins → Install plugin… → A plugin package
    (.zip), or point the folder option at farrasjibran.kanban/
  - a published version is immutable once a digest covers it; re-uploading the
    same version makes every install of it fail, so cut a new version instead
  - to appear in Browse marketplace…, mirror the repo on GitHub with the
    bentomux-plugin topic and a release carrying this zip
TIP

