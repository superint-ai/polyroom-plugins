#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: install.sh --room <polyroom room id> (--mention-handle <handle> | --mention-person <person id>)... [--kit-dir <folder>] [--venv <folder>] [--auto-compact-window <tokens>] [--compact-model <model id>]... [--disable-claude-ai-connectors]" >&2
  exit 64
}

refuse() {
  echo "refused $1: it takes only $2" >&2
  exit 64
}

uuid_pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
handle_pattern='^@?[A-Za-z][A-Za-z0-9_-]{1,39}$'
path_pattern='^/[A-Za-z0-9._/-]+$'
model_pattern='^[A-Za-z0-9._-]+$'

room=""
mention_args=()
kit_dir=/opt/polyroom-usage-kit
venv=/opt/claude-monitor-venv
auto_compact_window=300000
compact_models=()
disable_claude_ai_connectors=false
while [ $# -gt 0 ]; do
  case "$1" in
    --disable-claude-ai-connectors) disable_claude_ai_connectors=true; shift; continue ;;
    --room|--mention-handle|--mention-person|--kit-dir|--venv|--auto-compact-window|--compact-model) [ $# -ge 2 ] || usage ;;
    *) usage ;;
  esac
  case "$1" in
    --room) [[ "$2" =~ $uuid_pattern ]] || refuse --room 'a room id'; room="$2" ;;
    --mention-handle) [[ "$2" =~ $handle_pattern ]] || refuse --mention-handle 'a handle of letters, digits, _ and -'; mention_args+=(--mention-handle "$2") ;;
    --mention-person) [[ "$2" =~ $uuid_pattern ]] || refuse --mention-person 'a person id'; mention_args+=(--mention-person "$2") ;;
    --kit-dir) [[ "$2" =~ $path_pattern ]] || refuse --kit-dir 'an absolute path of letters, digits, ., _, - and /'; kit_dir="${2%/}" ;;
    --venv) [[ "$2" =~ $path_pattern ]] || refuse --venv 'an absolute path of letters, digits, ., _, - and /'; venv="${2%/}" ;;
    --auto-compact-window) [[ "$2" =~ ^[0-9]+$ ]] || refuse --auto-compact-window 'a number of tokens'; auto_compact_window="$2" ;;
    --compact-model) [[ "$2" =~ $model_pattern ]] || refuse --compact-model 'a model id'; compact_models+=("$2") ;;
  esac
  shift 2
done
[ -n "$room" ] && [ ${#mention_args[@]} -gt 0 ] || usage
[ ${#compact_models[@]} -gt 0 ] || compact_models=(claude-opus-5-5)
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

source_dir=$(cd "$(dirname "$0")" && pwd)
settings="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
token_dir="$kit_dir/token-usage"

echo "== packages"
missing_packages=()
command -v jq >/dev/null || missing_packages+=(jq)
[ -x "$venv/bin/claude-monitor" ] || python3 -c 'import venv, ensurepip' 2>/dev/null || missing_packages+=(python3-venv python3-pip)
[ ${#missing_packages[@]} -eq 0 ] || { apt-get update -qq; apt-get install -y -qq "${missing_packages[@]}"; }

echo "== claude-monitor"
[ -x "$venv/bin/claude-monitor" ] || { python3 -m venv "$venv"; "$venv/bin/pip" install -q claude-monitor==4.0.0; }
"$venv/bin/claude-monitor" --version 2>/dev/null | head -1 || true

echo "== kit files in $kit_dir"
mkdir -p "$token_dir"
if [ "$source_dir" != "$kit_dir" ]; then
  install -m 0755 "$source_dir/statusline-capture.sh" "$source_dir/usage-check.py" "$source_dir/install.sh" "$kit_dir/"
  install -m 0644 "$source_dir/token-usage/cost.py" "$source_dir/token-usage/snapshot.py" "$token_dir/"
fi
chmod 0755 "$kit_dir/statusline-capture.sh" "$kit_dir/usage-check.py" "$kit_dir/install.sh"
ln -sfn "$venv/bin/claude-monitor" "$kit_dir/claude-monitor"

echo "== statusLine in $settings"
mkdir -p "$(dirname "$settings")"
[ -s "$settings" ] || (umask 077 && echo '{}' > "$settings")
backup="$settings.before-usage-kit"
[ -e "$backup" ] || cp -a "$settings" "$backup"
models_json=$(printf '%s\n' "${compact_models[@]}" | jq -R . | jq -sc .)
edited=$(mktemp "$settings.XXXXXX")
trap 'rm -f "$edited"' EXIT
chmod --reference="$settings" "$edited"
chown --reference="$settings" "$edited"
jq --arg command "$kit_dir/statusline-capture.sh" --argjson window "$auto_compact_window" --argjson models "$models_json" --argjson disableConnectors "$disable_claude_ai_connectors" '
  .statusLine = {type: "command", command: $command}
  | (if $disableConnectors then .disableClaudeAiConnectors = true else . end)
  | .autoCompactWindow = $window
  | .modelSettings = ((.modelSettings // {}) as $current
      | reduce ((($current | keys) + $models) | unique)[] as $model ($current; .[$model].autoCompactWindow = $window))
' "$settings" > "$edited"
mv -f "$edited" "$settings"
trap - EXIT
jq -c '{statusLine, disableClaudeAiConnectors, autoCompactWindow, modelSettings}' "$settings"

echo "== first cost sample"
python3 "$token_dir/snapshot.py" sample

echo "== crontab"
cron_path=/usr/local/bin:/usr/bin:/bin
{
  crontab -l 2>/dev/null | grep -v -e '# polyroom-cost-sample' -e '# polyroom-usage-check' || true
  echo "* * * * * PATH=$cron_path python3 $token_dir/snapshot.py sample >> /var/log/polyroom-cost-sample.log 2>&1 # polyroom-cost-sample"
  echo "7,22,37,52 * * * * PATH=$cron_path python3 $kit_dir/usage-check.py --room $room ${mention_args[*]} >> /var/log/polyroom-usage-check.log 2>&1 # polyroom-usage-check"
} | crontab -
crontab -l | grep -e polyroom-cost-sample -e polyroom-usage-check

echo "== first reading (no post)"
python3 "$kit_dir/usage-check.py" --dry-run || true
echo "done. The context reading starts after the next Claude Code turn on this machine."
