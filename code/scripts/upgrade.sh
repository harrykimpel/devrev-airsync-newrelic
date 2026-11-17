#!/bin/bash
# Upgrade the chosen existing version/installation; never create a package/draft.
error() { echo "ERROR: $1" >&2; }
success() { echo "SUCCESS: $1"; }

if [ "${1:-}" = "--help" ]; then
    echo 'Usage: npm run upgrade -- <full-snap-in-version-id>'
    echo 'Run from code/. Uses DEV_ORG, USER_EMAIL and ENV from code/.env.'
    exit 0
fi
if [ "$#" -gt 1 ]; then
    error 'Pass exactly one snap-in version ID; force upgrades are not supported.'
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODE_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$CODE_DIR")"
if [ ! -f "$PROJECT_ROOT/manifest.yaml" ]; then
    error 'manifest.yaml not found.'
    exit 1
fi
if ! command -v devrev >/dev/null 2>&1; then
    error 'devrev CLI is not installed.'
    exit 1
fi
if [ -f "$CODE_DIR/.env" ]; then
    set -a
    source "$CODE_DIR/.env"
    set +a
fi
if [ -z "${DEV_ORG:-}" ] || [ -z "${USER_EMAIL:-}" ]; then
    error 'Set DEV_ORG and USER_EMAIL in code/.env or the environment.'
    exit 1
fi

UPGRADE_VERSION_ID="${1:-}"
if [ -z "$UPGRADE_VERSION_ID" ]; then
    read -r -p 'Enter the current full snap-in version ID: ' UPGRADE_VERSION_ID
fi
if [[ "$UPGRADE_VERSION_ID" != don:*:snap_in_package/*:snap_in_version/* ]] || [[ "$UPGRADE_VERSION_ID" == *[[:space:]]* ]]; then
    error 'Expected a full snap-in version DON, not a slug, package ID or installation ID.'
    exit 1
fi

source "$SCRIPT_DIR/devrev-auth.sh"
if ! authenticate_devrev "${ENV:-prod}" "$DEV_ORG" "$USER_EMAIL"; then
    exit 1
fi

# Released CLI versions use a positional ID. Some documented versions expose
# --version instead. Probe help so we never guess or use an implicit context.
if ! UPGRADE_HELP=$(devrev snap_in_version upgrade --help 2>&1) || ! grep -q 'devrev snap_in_version upgrade' <<<"$UPGRADE_HELP"; then
    error 'This CLI does not expose snap_in_version upgrade. Check devrev --version and upgrade --help.'
    exit 1
fi
UPGRADE_ARGS=()
if grep -qE '(^|[[:space:],])--version[[:space:]]+string' <<<"$UPGRADE_HELP"; then
    UPGRADE_ARGS=(--version "$UPGRADE_VERSION_ID")
elif grep -qE 'devrev snap_in_version upgrade[[:space:]]+(\[id\]|<id>)' <<<"$UPGRADE_HELP"; then
    UPGRADE_ARGS=("$UPGRADE_VERSION_ID")
else
    error 'This CLI does not advertise an explicit upgrade target. Upgrade aborted to avoid using an unrelated CLI context.'
    exit 1
fi

echo "Upgrading $UPGRADE_VERSION_ID in $DEV_ORG..."
# No --force: incompatible changes must fail without deleting installations.
if devrev snap_in_version upgrade "${UPGRADE_ARGS[@]}" --path "$PROJECT_ROOT" "${DEVREV_ENV_ARGS[@]}" --org "$DEV_ORG" --usr "$USER_EMAIL"; then
    success 'Upgrade command finished. Verify the resulting version/status in DevRev before starting another sync.'
else
    error 'Upgrade failed. No replacement installation was created by this script.'
    exit 1
fi
