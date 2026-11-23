#!/usr/bin/env bash
payload=$(cat)
state_dir="$HOME/.claude-monitor/context"
{
  mkdir -p "$state_dir" &&
  session_id=$(printf '%s' "$payload" | jq -r '.session_id // empty') &&
  [ -n "$session_id" ] &&
  printf '%s' "$payload" | jq -c --argjson now "$(date +%s)" '. + {captured_at_epoch: $now}' > "$state_dir/$session_id.json.tmp" &&
  mv -f "$state_dir/$session_id.json.tmp" "$state_dir/$session_id.json" &&
  cp -f "$state_dir/$session_id.json" "$state_dir/latest.json"
} >/dev/null 2>&1
printf '%s' "$payload" | "$(dirname "$0")/claude-monitor" --statusline
