#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: install.sh --room <polyroom room id> (--mention-handle <handle> | --mention-person <person id>)... [--kit-dir <folder>] [--auto-compact-window <tokens>] [--compact-model <model id>]... [--disable-claude-ai-connectors]" >&2
  exit 64
}

room=""
mention_args=()
kit_dir=/opt/polyroom-usage-kit
venv=/opt/claude-monitor-venv
auto_compact_window=300000
compact_models=()
disable_claude_ai_connectors=false
while [ $# -gt 0 ]; do
  case "$1" in
    --room) room="$2"; shift 2 ;;
    --mention-handle|--mention-person) mention_args+=("$1" "$2"); shift 2 ;;
    --kit-dir) kit_dir="$2"; shift 2 ;;
    --auto-compact-window) auto_compact_window="$2"; shift 2 ;;
    --compact-model) compact_models+=("$2"); shift 2 ;;
    --disable-claude-ai-connectors) disable_claude_ai_connectors=true; shift ;;
    *) usage ;;
  esac
done
[ -n "$room" ] && [ ${#mention_args[@]} -gt 0 ] || usage
[[ "$auto_compact_window" =~ ^[0-9]+$ ]] || usage
[ ${#compact_models[@]} -gt 0 ] || compact_models=(claude-opus-5-5)
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

source_dir=$(cd "$(dirname "$0")" && pwd)
settings="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
token_dir="$kit_dir/token-usage"

echo "== packages"
command -v jq >/dev/null && python3 -c 'import venv, ensurepip' 2>/dev/null || { apt-get update -qq; apt-get install -y -qq jq python3-venv python3-pip; }

echo "== claude-monitor"
[ -x "$venv/bin/claude-monitor" ] || { python3 -m venv "$venv"; "$venv/bin/pip" install -q claude-monitor==4.0.0; }
"$venv/bin/claude-monitor" --version 2>/dev/null | head -1 || true

echo "== kit files in $kit_dir"
mkdir -p "$token_dir"
if [ "$source_dir" != "$kit_dir" ]; then
  install -m 0755 "$source_dir/statusline-capture.sh" "$source_dir/usage-check.py" "$source_dir/install.sh" "$kit_dir/"
  install -m 0644 "$source_dir/token-usage/cost.py" "$source_dir/token-usage/snapshot.py" "$source_dir/token-usage/test_snapshot.py" "$token_dir/"
fi
chmod 0755 "$kit_dir/statusline-capture.sh" "$kit_dir/usage-check.py" "$kit_dir/install.sh"

echo "== statusLine in $settings"
mkdir -p "$(dirname "$settings")"
[ -s "$settings" ] || echo '{}' > "$settings"
cp -a "$settings" "$settings.before-usage-kit"
models_json=$(printf '%s\n' "${compact_models[@]}" | jq -R . | jq -sc .)
jq --arg command "$kit_dir/statusline-capture.sh" --argjson window "$auto_compact_window" --argjson models "$models_json" --argjson disableConnectors "$disable_claude_ai_connectors" '
  .statusLine = {type: "command", command: $command}
  | (if $disableConnectors then .disableClaudeAiConnectors = true else . end)
  | .autoCompactWindow = $window
  | .modelSettings = ((.modelSettings // {}) as $current
      | reduce ((($current | keys) + $models) | unique)[] as $model ($current; .[$model].autoCompactWindow = $window))
' "$settings" > "$settings.tmp"
mv -f "$settings.tmp" "$settings"
jq -c '{statusLine, disableClaudeAiConnectors, autoCompactWindow, modelSettings}' "$settings"

echo "== first cost sample"
python3 "$token_dir/snapshot.py" sample

echo "== crontab"
quoted_mentions=$(printf ' %q' "${mention_args[@]}")
{
  crontab -l 2>/dev/null | grep -v -e '# polyroom-cost-sample' -e '# polyroom-usage-check' || true
  echo "* * * * * PATH=/usr/local/bin:/usr/bin:/bin python3 $token_dir/snapshot.py sample >> /var/log/polyroom-cost-sample.log 2>&1 # polyroom-cost-sample"
  echo "7,22,37,52 * * * * PATH=/usr/local/bin:/usr/bin:/bin python3 $kit_dir/usage-check.py --room $room$quoted_mentions >> /var/log/polyroom-usage-check.log 2>&1 # polyroom-usage-check"
} | crontab -
crontab -l | grep -e polyroom-cost-sample -e polyroom-usage-check

echo "== first reading (no post)"
python3 "$kit_dir/usage-check.py" --dry-run || true
echo "done. The context reading starts after the next Claude Code turn on this machine."
