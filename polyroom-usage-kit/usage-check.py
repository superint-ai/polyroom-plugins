#!/usr/bin/env python3
import argparse
import json
import os
import socket
import sys
import time
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

STATE_DIR = Path.home() / '.claude-monitor'
MONITOR_STATE_FILE = STATE_DIR / 'statusline' / 'latest.json'
CONTEXT_DIR = STATE_DIR / 'context'
ALERT_STATE_FILE = STATE_DIR / 'usage-check-state.json'
HISTORY_FILE = STATE_DIR / 'usage-check-history.jsonl'
CLAUDE_CONFIG_FILE = Path.home() / '.claude.json'
MCP_PROTOCOL_VERSION = '2025-06-18'
MCP_TIMEOUT_SECONDS = 30
MONITOR_CAPTURE_SKEW_SECONDS = 600
WEEK_SECONDS = 7 * 24 * 3600
BRT = timezone(timedelta(hours=-3))
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_NEW_ALERT = 2
CONTEXT_FAMILY = 'context>='
LIMIT_FAMILIES = ('five_hour>=', 'week>=', 'week-pace:', 'week-projection>=')


def parse_arguments():
    parser = argparse.ArgumentParser(description='Evaluate Claude Code context, plan usage and limits from the claude-monitor statusline capture; alert once per threshold crossing.')
    parser.add_argument('--session-id', help='context file to read; default: the most recent capture')
    parser.add_argument('--context-token-levels', default='400000,600000')
    parser.add_argument('--five-hour-levels', default='80,95')
    parser.add_argument('--week-levels', default='70,85,95')
    parser.add_argument('--week-pace-margin', type=float, default=15.0)
    parser.add_argument('--week-projection-level', type=float, default=90.0)
    parser.add_argument('--week-projection-window-hours', type=float, default=6.0)
    parser.add_argument('--week-projection-hysteresis', type=float, default=5.0)
    parser.add_argument('--capture-max-age-minutes', type=float, default=360.0, help='older status line captures count as no current reading')
    parser.add_argument('--room', help='polyroom room id to post new alerts to')
    parser.add_argument('--mention-person', action='append', default=[])
    parser.add_argument('--mention-handle', action='append', default=[])
    parser.add_argument('--mcp-server', default='polyroom', help='name of the polyroom MCP server in ~/.claude.json')
    parser.add_argument('--dry-run', action='store_true', help='print only: no state, no history, no post')
    return parser.parse_args()


def levels(text):
    return sorted(float(item) for item in text.split(',') if item.strip())


def brt_text(epoch):
    return datetime.fromtimestamp(epoch, BRT).strftime('%d/%m %H:%M') if epoch else '?'


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def write_json_atomic(path, value):
    temporary = path.with_name(f'{path.name}.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    temporary.replace(path)


def add_levels(active, family, scope, value, thresholds, text_of):
    keys = []
    for level in thresholds:
        if value is not None and value >= level:
            key = f'{family}{level:.15g}:{scope}'
            active[key] = text_of(level)
            keys.append(key)
    return keys[:-1]


def thousands(value):
    if value >= 1_000_000:
        return f'{value / 1_000_000:g} milhão'.replace('.', ',')
    return f'{value / 1000:,.0f} mil'.replace(',', '.')


def read_history():
    try:
        lines = HISTORY_FILE.read_text(encoding='utf-8').splitlines()
    except OSError:
        return []
    records = []
    for line in lines:
        try:
            records.append(json.loads(line))
        except ValueError:
            continue
    return records


def week_projection(history, now, week_used, week_reset, window_hours):
    if week_used is None or not week_reset or week_reset <= now:
        return None, None
    window_start = now - window_hours * 3600
    samples = []
    for record in history:
        if record.get('weekResetsAt') != week_reset or record.get('weekPercent') is None:
            continue
        try:
            at = datetime.fromisoformat(record['at']).timestamp()
        except (KeyError, TypeError, ValueError):
            continue
        if window_start <= at < now:
            samples.append((at, record['weekPercent']))
    if not samples:
        return None, None
    oldest_at, oldest_percent = min(samples)
    span_hours = (now - oldest_at) / 3600
    if span_hours < window_hours / 2:
        return None, None
    rate = max(0.0, (week_used - oldest_percent) / span_hours)
    return round(rate, 2), round(week_used + rate * (week_reset - now) / 3600, 1)


def evaluate(arguments, now, previous, history):
    max_age = arguments.capture_max_age_minutes * 60
    monitor = read_json(MONITOR_STATE_FILE, {})
    context_file = CONTEXT_DIR / f'{arguments.session_id}.json' if arguments.session_id else CONTEXT_DIR / 'latest.json'
    capture = read_json(context_file, {})
    capture_epoch = capture.get('captured_at_epoch')
    monitor_epoch = monitor.get('captured_at_epoch')
    capture_fresh = bool(capture_epoch) and now - capture_epoch <= max_age
    monitor_fresh = bool(monitor_epoch) and now - monitor_epoch <= max_age
    limits = (monitor.get('rate_limits') or {}) if monitor_fresh else {}
    five_hour = limits.get('five_hour') or {}
    week = limits.get('seven_day') or {}
    window = capture.get('context_window') or {}
    current = window.get('current_usage') or {}
    context_tokens = sum(current.get(key) or 0 for key in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'))
    week_reset = week.get('resets_at')
    week_elapsed = round(100 * (1 - (week_reset - now) / WEEK_SECONDS), 1) if week_reset else None
    week_used = week.get('used_percentage')
    five_used = five_hour.get('used_percentage')

    active = {}
    superseded = []
    if capture_fresh:
        superseded += add_levels(active, CONTEXT_FAMILY, capture.get('session_id'), context_tokens, levels(arguments.context_token_levels), lambda level: (
            f"o contexto da sessão passou de {thousands(level)} tokens (agora {thousands(context_tokens)} de {thousands(window.get('context_window_size') or 0)}). "
            'A compactação automática (autoCompactWindow do settings.json) não rodou. Ação: conferir o settings.json e, se preciso, digitar /compact no console.'))
    superseded += add_levels(active, 'five_hour>=', five_hour.get('resets_at'), five_used, levels(arguments.five_hour_levels), lambda level: (
        f"a janela de 5 h passou de {level:g}% (agora {five_used:g}%, renova {brt_text(five_hour.get('resets_at'))} BRT). Ação: menos turnos até renovar."))
    superseded += add_levels(active, 'week>=', week_reset, week_used, levels(arguments.week_levels), lambda level: (
        f'a semana passou de {level:g}% (agora {week_used:g}%, ritmo linear {week_elapsed:g}%, renova {brt_text(week_reset)} BRT). '
        'Ação: menos turnos, ou passar trabalho para outra conta; trocar de modelo não ajuda.'))
    if week_used is not None and week_elapsed is not None and week_used >= week_elapsed + arguments.week_pace_margin:
        active[f'week-pace:{week_reset}'] = (
            f'a semana está à frente do ritmo: {week_used:g}% usados com {week_elapsed:g}% do tempo passado (margem {arguments.week_pace_margin:g} pontos). Ação: menos turnos.')
    week_rate, week_projected = week_projection(history, now, week_used, week_reset, arguments.week_projection_window_hours)
    projection_key = f'week-projection>={arguments.week_projection_level:g}:{week_reset}'
    projection_floor = arguments.week_projection_level - (arguments.week_projection_hysteresis if projection_key in previous else 0)
    if week_projected is not None and week_projected >= projection_floor:
        active[projection_key] = (
            f'no ritmo das últimas {arguments.week_projection_window_hours:g} h ({week_rate:g}% por hora), a semana chega a {week_projected:g}% antes de renovar ({brt_text(week_reset)} BRT). '
            'Ação: menos turnos, ou segurar a tarefa menos urgente desta máquina.')
    elif week_projected is None and projection_key in previous:
        active[projection_key] = ''
    if not capture_epoch:
        active['readout-missing:context'] = 'não há leitura de contexto: o statusLine não está passando pelo statusline-capture.sh. Ação: conferir o settings.json.'
    elif not capture_fresh:
        active['readout-stale:context'] = (
            f'a última leitura do statusLine é de {brt_text(capture_epoch)} BRT, há mais de {arguments.capture_max_age_minutes / 60:g} h: nenhum turno do Claude Code passou por ela desde então, e contexto e limites ficam sem leitura atual. '
            'Ação: conferir se a sessão está ativa e se o statusLine passa pelo statusline-capture.sh.')
    elif not monitor_epoch or capture_epoch - monitor_epoch > MONITOR_CAPTURE_SKEW_SECONDS:
        active['readout-missing:monitor'] = 'o claude-monitor parou de gravar os limites oficiais, embora a sessão esteja ativa. Ação: conferir o claude-monitor --statusline.'
    unknown = ((CONTEXT_FAMILY,) if not capture_fresh else ()) + (LIMIT_FAMILIES if not monitor_fresh else ())
    for key in previous:
        if key.startswith(unknown) and key not in active:
            active[key] = ''

    record = {
        'at': datetime.fromtimestamp(now, timezone.utc).isoformat(timespec='seconds'),
        'hostname': socket.gethostname(),
        'fiveHourPercent': five_used,
        'fiveHourResetsAt': five_hour.get('resets_at'),
        'weekPercent': week_used,
        'weekElapsedPercent': week_elapsed,
        'weekResetsAt': week_reset,
        'weekRatePerHour': week_rate,
        'weekProjectedPercent': week_projected,
        'contextTokens': context_tokens,
        'contextWindowSize': window.get('context_window_size'),
        'contextPercent': window.get('used_percentage'),
        'contextSessionId': capture.get('session_id'),
        'captureAgeSeconds': round(now - capture_epoch) if capture_epoch else None,
        'monitorAgeSeconds': round(now - monitor_epoch) if monitor_epoch else None,
        'activeAlerts': sorted(active),
    }
    return record, active, set(superseded)


def mcp_target(server_name):
    config = read_json(CLAUDE_CONFIG_FILE, {})
    candidates = [config.get('mcpServers') or {}] + [(project or {}).get('mcpServers') or {} for project in (config.get('projects') or {}).values()]
    for servers in candidates:
        server = servers.get(server_name)
        if server and server.get('url'):
            return server['url'], server.get('headers') or {}
    raise RuntimeError(f'MCP server {server_name} with a url not found in {CLAUDE_CONFIG_FILE}')


def mcp_post(url, headers, body, session_id=None):
    request_headers = {**headers, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'User-Agent': 'polyroom-usage-check/1.0'}
    if session_id:
        request_headers['Mcp-Session-Id'] = session_id
        request_headers['MCP-Protocol-Version'] = MCP_PROTOCOL_VERSION
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=request_headers, method='POST')
    with urllib.request.urlopen(request, timeout=MCP_TIMEOUT_SECONDS) as response:
        text = response.read().decode('utf-8', 'replace')
        new_session = response.headers.get('Mcp-Session-Id')
    if not text.strip():
        return None, new_session
    if text.lstrip().startswith('{'):
        return json.loads(text), new_session
    payloads = [line[5:].strip() for line in text.splitlines() if line.startswith('data:')]
    messages = [json.loads(payload) for payload in payloads if payload]
    replies = [message for message in messages if message.get('id') == body.get('id')]
    return (replies or messages or [None])[-1], new_session


def mcp_session(server_name):
    url, headers = mcp_target(server_name)
    initialize = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': MCP_PROTOCOL_VERSION, 'capabilities': {}, 'clientInfo': {'name': 'polyroom-usage-check', 'version': '1.0'}}}
    _, session_id = mcp_post(url, headers, initialize)
    mcp_post(url, headers, {'jsonrpc': '2.0', 'method': 'notifications/initialized'}, session_id)
    return url, headers, session_id


def mcp_tool(session, request_id, name, tool_arguments):
    url, headers, session_id = session
    reply, _ = mcp_post(url, headers, {'jsonrpc': '2.0', 'id': request_id, 'method': 'tools/call', 'params': {'name': name, 'arguments': tool_arguments}}, session_id)
    result = (reply or {}).get('result') or {}
    if not reply or reply.get('error') or result.get('isError'):
        raise RuntimeError(f'{name} failed: {json.dumps(reply)[:500]}')
    text = ''.join(part.get('text', '') for part in result.get('content') or [])
    return json.loads(text) if text.strip().startswith('{') else {}


def bot_handle(session):
    handle = (mcp_tool(session, 2, 'chat_identity', {}).get('identity') or {}).get('handle')
    if not handle:
        raise RuntimeError('chat_identity returned no handle')
    return handle


def post_alert(session, arguments, content, client_id):
    send_arguments = {'roomId': arguments.room, 'clientId': client_id, 'content': content}
    if arguments.mention_person:
        send_arguments['mentionPersonIds'] = arguments.mention_person
    if arguments.mention_handle:
        send_arguments['mentionHandles'] = arguments.mention_handle
    return mcp_tool(session, 3, 'chat_send_message', send_arguments).get('message', {}).get('id')


def alert_content(record, active, new_keys, now):
    projection = record['weekProjectedPercent'] if record['weekProjectedPercent'] is not None else '?'
    return '\n'.join(
        [f"Aviso automático de uso do Claude Code de @{record['handle']} (máquina `{record['hostname']}`, medido às {brt_text(now)} BRT, pelo claude-monitor):"]
        + [f'- {active[key]}' for key in new_keys]
        + [f"\nLeitura completa: 5 h {record['fiveHourPercent']}%, semana {record['weekPercent']}% (ritmo linear {record['weekElapsedPercent']}%, projeção {projection}%), contexto {thousands(record['contextTokens'])} tokens."])


def summary_line(record, new_alerts):
    size = record['contextWindowSize']
    context = f"{record['contextTokens'] / 1000:.0f}k/{size / 1000:.0f}k ({record['contextPercent']}%)" if size else f"{record['contextTokens'] / 1000:.0f}k"
    age = record['captureAgeSeconds']
    return ' | '.join([
        f'NEW ALERT ({len(new_alerts)})' if new_alerts else 'ok',
        f"5h {record['fiveHourPercent']}% (resets {brt_text(record['fiveHourResetsAt'])} BRT)",
        f"week {record['weekPercent']}% vs linear {record['weekElapsedPercent']}%, projected {record['weekProjectedPercent'] if record['weekProjectedPercent'] is not None else '?'}% (resets {brt_text(record['weekResetsAt'])} BRT)",
        f'context {context}',
        f"capture {round(age / 60) if age is not None else '?'} min old",
    ])


def save_state(active, pending, at):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    write_json_atomic(ALERT_STATE_FILE, {'active': sorted(active), 'pending': pending, 'updatedAt': at})


def main():
    arguments = parse_arguments()
    now = time.time()
    state = read_json(ALERT_STATE_FILE, {})
    previous = set(state.get('active', []))
    pending = state.get('pending') if arguments.room else None
    pending_keys = set(pending.get('keys', [])) if pending else set()
    record, active, superseded = evaluate(arguments, now, previous | pending_keys, read_history())
    new_keys = [key for key in sorted(active) if key not in previous]
    shown = [key for key in new_keys if key not in superseded]
    print(summary_line(record, shown))
    for key in shown:
        print(f'  {key}: {active[key]}')
    if arguments.dry_run:
        return EXIT_NEW_ALERT if new_keys else EXIT_OK

    exit_code = EXIT_NEW_ALERT if new_keys else EXIT_OK
    kept = set(active) - set(new_keys)
    fresh = [key for key in shown if key not in pending_keys]
    record['postedMessageIds'] = []
    if arguments.room and (pending or fresh):
        try:
            session = mcp_session(arguments.mcp_server)
            if pending:
                record['postedMessageIds'].append(post_alert(session, arguments, pending['content'], pending['clientId']))
                kept |= pending_keys & set(active)
                pending = None
            if fresh:
                record['handle'] = bot_handle(session)
                pending = {'keys': fresh, 'content': alert_content(record, active, fresh, now), 'clientId': f'usage-check-{uuid.uuid4().hex[:24]}'}
                save_state(kept, pending, record['at'])
                record['postedMessageIds'].append(post_alert(session, arguments, pending['content'], pending['clientId']))
                pending = None
            kept |= set(new_keys)
            print(f"  posted messages {', '.join(map(str, record['postedMessageIds']))}")
        except Exception as error:
            record['postError'] = f'{type(error).__name__}: {error}'[:500]
            print(f"  post failed, will retry next run: {record['postError']}")
            exit_code = EXIT_FAILED
    else:
        kept |= set(new_keys)
        pending = None

    record['newAlerts'] = shown
    save_state(kept, pending, record['at'])
    with HISTORY_FILE.open('a', encoding='utf-8') as history:
        history.write(json.dumps(record) + '\n')
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
