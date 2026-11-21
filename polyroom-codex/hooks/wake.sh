#!/bin/sh
set -u
umask 077

main() {
  parent=$PPID
  product=${1:-}
  action=${2:-}
  case "$product:$action" in
    codex:wait|codex:session-start|codex:claim|claude:wait|claude:session-start|claude:claim) ;;
    *) printf '%s\n' 'usage: wake.sh codex|claude wait|session-start|claim' >&2; exit 64 ;;
  esac

  if [ -n "${POLYROOM_WAKE_DIR:-}" ]; then
    dir=$POLYROOM_WAKE_DIR
  elif [ "$product" = codex ]; then
    dir=${CODEX_HOME:-$HOME/.codex}/polyroom
  else
    dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/polyroom
  fi
  config=$dir/wake.env
  plugin_root=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
  server_entry=$({ awk '
    function closed() { if (depth == 0) state[0] = "end"; else state[depth] = "next" }
    function at_value() { return state[depth] == "value" || (kind[depth] == "[" && state[depth] == "first") }
    { text = text $0 "\n" }
    END {
      n = length(text); depth = 0; state[0] = "value"; kind[0] = ""; bad = 0; servers = 0; mcp = 0; last = ""
      for (i = 1; i <= n && !bad; i++) {
        c = substr(text, i, 1)
        if (c == " " || c == "\t" || c == "\r" || c == "\n") continue
        if (state[depth] == "end") { bad = 1; break }
        if (c == "\"") {
          s = ""; ended = 0
          for (i++; i <= n; i++) {
            c = substr(text, i, 1)
            if (c == "\"") { ended = 1; break }
            if (c ~ /[\001-\037]/) break
            if (c == "\\") {
              e = substr(text, i + 1, 1)
              if (e == "u") { if (substr(text, i + 2, 4) !~ /^[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]$/) break; s = s "\\u" substr(text, i + 2, 4); i += 5; continue }
              if (index("\"\\/bfnrt", e) == 0 || e == "") break
              s = s (e == "/" ? "/" : c e); i++; continue
            }
            s = s c
          }
          if (!ended) { bad = 1; break }
          if (kind[depth] == "{" && (state[depth] == "first" || state[depth] == "key")) {
            key[depth] = s; state[depth] = "colon"
            if (depth == 2 && key[1] == "mcpServers") { servers++; last = s; if (s !~ /^[A-Za-z0-9_-]+$/) bad = 1 }
            continue
          }
          if (!at_value()) { bad = 1; break }
          if (depth == 3 && key[1] == "mcpServers" && key[3] == "url") url[key[2]] = s
          closed(); continue
        }
        if (c == "{" || c == "[") {
          if (!at_value() || (depth == 0 && c != "{")) { bad = 1; break }
          if (depth == 1 && key[1] == "mcpServers") mcp = (c == "{")
          if (depth == 2 && key[1] == "mcpServers") object[key[2]] = (c == "{")
          depth++; kind[depth] = c; state[depth] = "first"; key[depth] = ""
          continue
        }
        if (c == "}" || c == "]") {
          if (depth == 0 || (c == "}") != (kind[depth] == "{") || (state[depth] != "next" && state[depth] != "first")) { bad = 1; break }
          depth--; closed(); continue
        }
        if (c == ":") { if (state[depth] != "colon") { bad = 1; break } state[depth] = "value"; continue }
        if (c == ",") { if (state[depth] != "next") { bad = 1; break } state[depth] = (kind[depth] == "{") ? "key" : "value"; continue }
        if (!at_value()) { bad = 1; break }
        rest = substr(text, i)
        if (match(rest, /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/)) { i += RLENGTH - 1; closed(); continue }
        if (substr(rest, 1, 4) == "true" || substr(rest, 1, 4) == "null") { i += 3; closed(); continue }
        if (substr(rest, 1, 5) == "false") { i += 4; closed(); continue }
        bad = 1
      }
      if (!bad && state[0] == "end" && mcp && servers == 1 && object[last] && url[last] != "") { print last; print url[last] }
    }' "$plugin_root/.mcp.json"; } 2>/dev/null)
  server_name=$(printf '%s\n' "$server_entry" | sed -n 1p)
  server_url=$(printf '%s\n' "$server_entry" | sed -n 2p)
  idle_text='No new polyroom notices. Call the polyroom tool chat_identity once so this session keeps waiting, then end the turn with one word.'
  refused_text='The chat refused the polyroom wake token, so this session stopped waiting for notices: the connection was removed or expired, or the agent or its workspace was deleted. Tell the person in one sentence, and say they can type Connect polyroom to connect again.'
  connected_text='polyroom connected this conversation, and it now waits for notices. Tell the person in one short sentence that it is connected, then end the turn.'
  code_refused_text='The chat refused the polyroom connection code, so this conversation is not connected. Tell the person, and run the polyroom connect skill again only if they ask.'
  address_missing_text='The polyroom plugin has no chat address in its .mcp.json, so this conversation is not connected. Tell the person to reinstall the polyroom plugin.'
  unreachable_text='polyroom could not reach the chat to connect this conversation. Tell the person to check the network, and run the polyroom connect skill again only if they ask.'
  foreign_code_text='The polyroom connection code was not used, because this conversation did not get it from the chat_wake_code tool of polyroom. Tell the person, and run the polyroom connect skill again only if they ask.'
  busy_text='Another polyroom session on this computer already waits for notices for this agent, so this session does not wait. Close the other session, then send any message here so this one waits.'
  already_connected_text='This conversation is already connected to polyroom, so the new connection code was not used. To connect another agent, the person removes this connection on the Agents page of polyroom (open the agent, Edit in Connections, Revoke next to the connection under Connections and tokens, then Save), and then runs the polyroom connect skill again.'

  setting() {
    value=$(sed -n "s/^$1=//p" "$config" 2>/dev/null | tail -n 1 | tr -d '\r')
    printf '%s' "${value:-$2}"
  }

  number_setting() {
    value=$(setting "$1" "$2")
    case "$value" in
      ''|*[!0-9]*) printf '%s' "$2" ;;
      *) printf '%s' "$value" ;;
    esac
  }

  save_setting() {
    temporary=$config.$$.tmp
    { grep -v "^$1=" "$config" 2>/dev/null; [ -z "$2" ] || printf '%s=%s\n' "$1" "$2"; } > "$temporary" && mv -f "$temporary" "$config"
  }

  token_mark() {
    printf '%s' "$token" | cksum | cut -d ' ' -f 1
  }

  marked_number() {
    saved_mark='' saved_number='' saved_turn=''
    [ -f "$1" ] || return 1
    read -r saved_mark saved_number saved_turn < "$1" || [ -n "$saved_mark" ] || return 1
    if [ -z "$saved_number" ]; then
      is_number "$saved_mark" || return 1
      printf '%s' "$saved_mark"
    elif [ "$saved_mark" = "$(token_mark)" ] && is_number "$saved_number"; then
      printf '%s' "$saved_number"
    else
      return 2
    fi
  }

  save_marked() {
    printf '%s %s%s\n' "$(token_mark)" "$2" "${3:+ $3}" > "$1"
  }

  stop_field() {
    printf '%s' "$stop_input" | sed -n "s/.*\"$1\" *: *\"\([A-Za-z0-9_.:-]*\)\".*/\\1/p" | head -n 1
  }

  orphaned() {
    kill -0 "$parent" 2>/dev/null || return 0
    adopter=$(ps -o ppid= -p "$$" 2>/dev/null | tr -d ' ')
    [ -n "$adopter" ] || [ ! -r "/proc/$$/stat" ] || adopter=$(sed 's/.*) //' "/proc/$$/stat" | cut -d ' ' -f 2)
    [ -n "$adopter" ] && [ "$adopter" != "$parent" ]
  }

  connected_as_before() {
    [ "$(setting POLYROOM_WAKE_TOKEN '')" = "$token" ]
  }

  is_number() {
    case "$1" in
      ''|*[!0-9]*) return 1 ;;
      *) return 0 ;;
    esac
  }

  url=$(setting POLYROOM_WAKE_URL '')
  url=${url%/}
  token=$(setting POLYROOM_WAKE_TOKEN '')
  code=$(setting POLYROOM_WAKE_CODE '')
  budget=$(number_setting POLYROOM_WAKE_BUDGET_SECONDS 1740)
  wait_seconds=$(number_setting POLYROOM_WAKE_WAIT_SECONDS 20)
  margin=$(number_setting POLYROOM_WAKE_MARGIN_SECONDS 15)
  retry_min=$(number_setting POLYROOM_WAKE_RETRY_MIN_SECONDS 2)
  retry_max=$(number_setting POLYROOM_WAKE_RETRY_MAX_SECONDS 60)
  unknown_cursor=999999999999999
  body=$dir/.body.$$
  headers=$dir/.headers.$$
  auth=$dir/.auth.$$
  answer=$dir/.status.$$
  lock=$dir/wake.lock
  staged=$lock/.new.$$
  record=''
  child=''
  stop=''

  top_record() {
    ls "$lock" 2>/dev/null | grep -E '^[0-9]+$' | sort -n | tail -n 1
  }

  holds_lock() {
    [ -n "$record" ] && [ "$(top_record)" = "$record" ]
  }

  release_lock() {
    [ -n "$record" ] || return 0
    if holds_lock; then
      { printf 'released\n' > "$staged" && mv -f "$staged" "$lock/$record"; } 2>/dev/null || rm -f "$staged"
    else
      rm -f "$lock/$record"
    fi
  }

  cleanup() {
    if [ -n "$child" ]; then
      kill -s KILL "$child" 2>/dev/null
      wait "$child" 2>/dev/null
    fi
    rm -f "$body" "$headers" "$auth" "$answer" "$config.$$.tmp" "$staged"
    release_lock
  }
  trap cleanup EXIT
  trap 'if [ -n "$record" ] && ! holds_lock; then stop=0; else stop=143; fi; [ -z "$child" ] || exit "$stop"' TERM INT HUP

  await_child() {
    child=$!
    [ -z "$stop" ] || exit "$stop"
    wait "$child"
    finished=$?
    child=''
    return "$finished"
  }

  pause() {
    sleep "$1" &
    await_child
  }

  sweep() {
    for leftover in "$dir"/.auth.* "$dir"/.headers.* "$dir"/.body.* "$dir"/.status.* "$config".*.tmp; do
      owner=${leftover%.tmp}
      owner=${owner##*.}
      is_number "$owner" || continue
      [ "$owner" = "$$" ] || ! kill -0 "$owner" 2>/dev/null || continue
      rm -f "$leftover"
    done
  }
  sweep

  claim() {
    case "$code" in
      ''|*[!A-Za-z0-9_-]*) printf '%s\n' 'No valid POLYROOM_WAKE_CODE in wake.env.' >&2; return 1 ;;
    esac
    printf '{"code":"%s"}' "$code" | curl -s -o "$body" -w '%{http_code}' --max-time "$((wait_seconds + margin))" -X POST \
      -H 'Content-Type: application/json' -H 'User-Agent: polyroom-wake/1' \
      --data-binary @- "$url/wake/claim" > "$answer" &
    await_child && status=$(cat "$answer" 2>/dev/null) || status=000
    received=$(tr -d '\r\n' < "$body" 2>/dev/null)
    case "$status:$received" in
      200:saw_*)
        case "$received" in
          *[!A-Za-z0-9_-]*) printf '%s\n' 'The chat answered the claim with an invalid token.' >&2; return 1 ;;
        esac
        save_setting POLYROOM_WAKE_TOKEN "$received" && save_setting POLYROOM_WAKE_CODE '' || return 1
        token=$received
        save_marked "$dir/cursor" "$unknown_cursor" || return 1
        rm -f "$dir/stopped" "$dir/pending"
        return 0 ;;
    esac
    printf 'The chat refused the connection code (HTTP %s). Run the connect skill again for a new code.\n' "$status" >&2
    return 1
  }

  deliver_text() {
    if [ "$product" = codex ]; then
      printf '{"decision":"block","reason":"%s"}\n' "$1"
      exit 0
    fi
    printf '%s\n' "$1" >&2
    exit 2
  }

  issued_here() {
    [ -n "$transcript" ] && [ -f "$transcript" ] || return 1
    tries=0
    while :; do
      grep -F "\"server\":\"$server_name\",\"tool\":\"chat_wake_code\"" "$transcript" 2>/dev/null | grep -F -q "\"structuredContent\":{\"code\":\"$offered\"" && return 0
      tries=$((tries + 1))
      [ "$tries" -lt 5 ] || return 1
      pause 1
    done
  }

  connect_from_stop() {
    [ -n "$stop_input" ] || return 0
    if [ -z "$server_name" ]; then
      printf '%s' "$stop_input" | grep -q ' wake code: `\{0,1\}swc_[A-Za-z0-9_-]\{43\}' && deliver_text "$address_missing_text"
      return 0
    fi
    offered=$(printf '%s' "$stop_input" | grep -o "$server_name"' wake code: `\{0,1\}swc_[A-Za-z0-9_-]\{43\}`\{0,1\}\(\\n\)\{0,1\}"' | tail -n 1 | grep -o 'swc_[A-Za-z0-9_-]\{43\}')
    [ -n "$offered" ] || return 0
    [ -z "$token" ] || [ -f "$dir/stopped" ] || deliver_text "$already_connected_text"
    transcript=$(printf '%s' "$stop_input" | sed -n 's/.*"transcript_path" *: *"\([^"]*\)".*/\1/p' | head -n 1)
    issued_here || deliver_text "$foreign_code_text"
    plugin_url=$server_url
    plugin_url=${plugin_url%/}
    plugin_url=${plugin_url%/mcp}
    [ -n "$plugin_url" ] || deliver_text "$address_missing_text"
    mkdir -p "$dir" || exit 0
    url=$plugin_url
    code=$offered
    { save_setting POLYROOM_WAKE_URL "$url" && save_setting POLYROOM_WAKE_TOKEN '' && save_setting POLYROOM_WAKE_CODE "$code"; } || exit 0
    status=''
    claim && deliver_text "$connected_text"
    save_setting POLYROOM_WAKE_CODE ''
    [ "$status" != 000 ] || deliver_text "$unreachable_text"
    deliver_text "$code_refused_text"
  }

  stop_input=''
  [ "$action" != wait ] || [ -t 0 ] || stop_input=$(cat)
  session=$(stop_field session_id)
  turn=$(stop_field turn_id)
  prompt=$(stop_field prompt_id)
  [ "$product:$action" != codex:wait ] || connect_from_stop

  [ -d "$dir" ] || exit 0
  [ -n "$url" ] || exit 0

  if [ "$action" = claim ]; then
    claim || exit 1
    printf '%s\n' 'Connected: this session now wakes on polyroom notices.'
    exit 0
  fi

  [ ! -f "$dir/stopped" ] || exit 0
  if [ -z "$token" ]; then
    [ -n "$code" ] || exit 0
    claim || exit 0
  fi
  printf 'Authorization: Bearer %s\n' "$token" > "$auth"

  read_cursor() {
    cursor=$(marked_number "$dir/cursor")
    case $? in
      0) ;;
      2) cursor=$unknown_cursor ;;
      *) cursor=0 ;;
    esac
  }
  read_cursor

  request() {
    curl -s -o "$body" -D "$headers" -w '%{http_code}' --max-time "$2" \
      -H "@$auth" -H 'User-Agent: polyroom-wake/1' "$url/wake?$1" > "$answer" &
    await_child && status=$(cat "$answer" 2>/dev/null) || status=000
    next=$(tr -d '\r' < "$headers" 2>/dev/null | sed -n 's/^[Xx]-[Pp][Oo][Ll][Yy][Rr][Oo][Oo][Mm]-[Cc][Uu][Rr][Ss][Oo][Rr]: *//p' | tail -n 1)
  }

  deliver_file() {
    if [ "$product" = codex ]; then
      cat "$body"
      exit 0
    fi
    cat "$body" >&2
    exit 2
  }

  if [ "$action" = session-start ]; then
    marked_number "$dir/pending" > /dev/null || exit 0
    request "after=$cursor&wait=0&format=session-start&redelivery=1" "$margin"
    [ "$status" != 200 ] || cat "$body"
    exit 0
  fi

  busy() {
    [ "$product" != codex ] || printf '{"systemMessage":"%s"}\n' "$busy_text"
    exit 0
  }

  start_mark() {
    if [ -r "/proc/$1/stat" ]; then
      set -- $(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null)
      [ "$#" -ge 20 ] || return 1
      printf 'start:%s:%s\n' "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" "${20}"
      return 0
    fi
    started=$(LC_ALL=C TZ=UTC0 ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//; s/ *$//')
    [ -n "$started" ] || return 1
    printf 'start:%s\n' "$started"
  }

  old_record_minutes=$(( (budget + margin + 59) / 60 + 1 ))

  recent_record() {
    [ -n "$(find "$1" -mmin "-$old_record_minutes" 2>/dev/null)" ]
  }

  read_holder() {
    holder_pid='' holder_session='' holder_turn='' holder_start=''
    if [ -n "$1" ]; then
      [ -f "$lock/$1" ] || return 1
      holder_path=$lock/$1
      { IFS= read -r holder_pid; IFS= read -r holder_session; IFS= read -r holder_turn; IFS= read -r holder_start; } 2>/dev/null < "$holder_path"
    else
      holder_path=$lock/pid
      holder_pid=$(cat "$lock/pid" 2>/dev/null)
      held_by=$(cat "$lock/owner" 2>/dev/null)
      holder_session=${held_by%% *}
      holder_turn=${held_by#* }
    fi
    is_number "$holder_pid" || holder_pid=''
    return 0
  }

  holder_alive() {
    [ -n "$holder_pid" ] && [ "$holder_pid" != "$$" ] && kill -0 "$holder_pid" 2>/dev/null || return 1
    case $holder_start in
      start:?*) [ "$(start_mark "$holder_pid")" = "$holder_start" ] ;;
      *) recent_record "$holder_path" ;;
    esac
  }

  await_lock_test() {
    [ -n "${POLYROOM_WAKE_LOCK_TEST_GATE:-}" ] || return 0
    printf '%s\n' "$1" > "$POLYROOM_WAKE_LOCK_TEST_GATE/$$"
    tries=0
    while [ ! -e "$POLYROOM_WAKE_LOCK_TEST_GATE/$$.go" ] && [ "$tries" -lt 400 ]; do
      tries=$((tries + 1))
      sleep 0.05 2>/dev/null || sleep 1
    done
  }

  earlier_holders() {
    earlier=''
    for path in "$lock"/*; do
      name=${path##*/}
      case $name in ''|*[!0-9]*) continue ;; esac
      if [ "$name" -lt "$record" ] && read_holder "$name" && holder_alive; then earlier="$earlier $holder_pid"; fi
    done
    read_holder ''
    ! holder_alive || earlier="$earlier $holder_pid"
    [ -n "$earlier" ]
  }

  stop_earlier_holders() {
    earlier_holders || return 0
    kill -s TERM $earlier 2>/dev/null
    tries=0
    while earlier_holders && [ "$tries" -lt 60 ]; do
      tries=$((tries + 1))
      [ "$tries" -ne 50 ] || kill -s KILL $earlier 2>/dev/null
      sleep 0.1 2>/dev/null || sleep 1
    done
    ! earlier_holders
  }

  tidy_lock() {
    for path in "$lock"/.new.* "$lock"/*; do
      name=${path##*/}
      case $name in
        .new.*)
          ! is_number "${name#.new.}" || kill -0 "${name#.new.}" 2>/dev/null || rm -f "$path" ;;
        ''|*[!0-9]*) ;;
        *)
          if [ "$name" -lt "$record" ] && read_holder "$name" && ! holder_alive; then rm -f "$path"; fi ;;
      esac
    done
    read_holder ''
    holder_alive || rm -f "$lock/pid" "$lock/owner"
  }

  mkdir -p "$lock" 2>/dev/null
  top=$(top_record)
  read_holder "$top" || busy
  if holder_alive; then
    [ -n "$session" ] && [ "$holder_session" = "$session" ] && [ "$holder_turn" != "${turn:-$prompt}" ] || busy
  fi
  await_lock_test "${top:-0}"
  next=$(( ${top:-0} + 1 ))
  if ! { printf '%s\n%s\n%s\n%s\n' "$$" "$session" "${turn:-$prompt}" "$(start_mark "$$")" > "$staged" && ln "$staged" "$lock/$next"; } 2>/dev/null; then
    rm -f "$staged"
    busy
  fi
  rm -f "$staged"
  record=$next
  stop_earlier_holders || exit 0
  holds_lock || exit 0
  tidy_lock
  read_cursor

  if pending=$(marked_number "$dir/pending"); then
    pending_turn=$(sed -n '1s/^[^ ]* [^ ]* *//p' "$dir/pending" 2>/dev/null)
    if [ -z "$pending_turn" ] || [ "$pending_turn" = "$turn" ]; then
      cursor=$pending
      save_marked "$dir/cursor" "$cursor"
    fi
  fi
  rm -f "$dir/pending"

  if [ "$product" = codex ]; then format=stop; else format=text; fi
  deadline=$(( $(date +%s) + budget ))
  backoff=$retry_min
  while :; do
    left=$(( deadline - $(date +%s) ))
    wait_now=$wait_seconds
    [ $((wait_now + margin)) -le "$left" ] || wait_now=$((left - margin))
    [ "$wait_now" -ge 1 ] || break
    connected_as_before || exit 0
    ! orphaned || exit 0
    holds_lock || exit 0
    request "after=$cursor&wait=$wait_now&format=$format" "$((wait_now + margin))"
    if ! connected_as_before; then
      [ "$status" != 200 ] || ! is_number "$next" || deliver_file
      exit 0
    fi
    holds_lock || exit 0
    case "$status" in
      200)
        if is_number "$next"; then
          ! orphaned || exit 0
          save_marked "$dir/pending" "$next" "$turn"
          deliver_file
        fi ;;
      204)
        if [ "$cursor" = "$unknown_cursor" ] && [ "$next" = "$unknown_cursor" ]; then
          cursor=0
          save_marked "$dir/cursor" "$cursor"
        elif is_number "$next" && [ "$next" != "$cursor" ]; then
          cursor=$next
          save_marked "$dir/cursor" "$cursor"
        fi
        backoff=$retry_min
        continue ;;
      401|403)
        : > "$dir/stopped"
        deliver_text "$refused_text" ;;
    esac
    left=$(( deadline - $(date +%s) - margin ))
    [ "$left" -ge 1 ] || break
    [ "$backoff" -le "$left" ] || backoff=$left
    pause "$backoff"
    backoff=$((backoff * 2))
    [ "$backoff" -le "$retry_max" ] || backoff=$retry_max
  done
  holds_lock || exit 0
  deliver_text "$idle_text"
}

main "$@"; exit
