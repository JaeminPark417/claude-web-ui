#!/bin/bash
# Open the CURRENT terminal Claude session as a math-rendered MIRROR surface in the current pane.
# Deterministic (no agent ambiguity): the injection target is THIS terminal's surface (identify's
# caller), captured BEFORE creating the browser surface — never the new browser surface.
set -uo pipefail
PORT="${CLAUDE_WEB_PORT:-8765}"
BASE="http://127.0.0.1:${PORT}/mirror"

# 1. ensure server (the launcher runs it under launchd → survives this session ending)
curl -fs -o /dev/null -m 2 "$BASE" 2>/dev/null || bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/claude-web" --no-open >/dev/null 2>&1

# 2. THIS terminal session's surface (= remote-input target) and pane (= where to add the tab).
#    Prefer the STABLE surface UUID over the short ref (refs like surface:39 can be reused after a
#    surface is closed/reopened); cmux send accepts either form. The mirror server strips its own
#    cmux caller-context before `cmux send`, so the UUID resolves globally regardless of which
#    workspace the server was launched in (see server.mjs injectToTerminal).
ID="$(cmux identify --id-format both 2>/dev/null)"
SR="$(printf '%s' "$ID" | jq -r '.caller.surface_ref // empty')"
SUUID="$(printf '%s' "$ID" | jq -r '.caller.surface_id // empty')"
PR="$(printf '%s' "$ID" | jq -r '.caller.pane_ref // empty')"
[ -n "$SR" ] && [ -n "$PR" ] || { echo "ERROR: cmux identify gave no caller surface/pane"; exit 1; }
TGT="${SUUID:-$SR}"   # inject target: stable UUID if available, else short ref

# 3. THIS session's id — from the per-session env var (race-free across concurrent workspaces);
#    the shared /tmp/claude-statusline.json is last-writer-wins, so only a last-resort fallback.
SESS="${CLAUDE_CODE_SESSION_ID:-$(jq -r '.session_id // empty' /tmp/claude-statusline.json 2>/dev/null)}"

# fallback target (older single-target path); the URL surface= is authoritative
printf '%s' "$TGT" > "$HOME/repos/claude-web-ui/.target-surface" 2>/dev/null || true

Q="surface=${TGT}"
[ -n "$SESS" ] && Q="session=${SESS}&${Q}"

# 4. open as a browser SURFACE in this pane (not a split), bound to this session + surface
cmux new-surface --type browser --pane "$PR" --focus true --url "${BASE}?${Q}" >/dev/null 2>&1
echo "mirror opened → ${BASE}?${Q}  (terminal surface=${SR})"
