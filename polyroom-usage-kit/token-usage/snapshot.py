import argparse
import ast
import json
import os
import re
import shutil
import socket
import subprocess
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DEFAULT_PROJECTS_DIR = Path.home() / '.claude' / 'projects'
DEFAULT_STATE_DIR = Path.home() / '.cache' / 'polyroom-cost'
DEFAULT_CLAUDE_CONFIG = Path.home() / '.claude.json'
DEFAULT_COST_TABLE = Path(__file__).with_name('cost.py')
DEFAULT_DISK_PATH = '/'
DEFAULT_DOCKER_COMMAND = 'docker'
DEFAULT_DOCKER_TIMEOUT_SECONDS = 20
DEFAULT_UTC_OFFSET_HOURS = -3
DEFAULT_WINDOW_HOURS = 4

SAMPLES_FILE = 'samples.jsonl'
BASELINE_FILE = 'baseline.json'
SYNTHETIC_MODEL = '<synthetic>'
TOKEN_FIELDS = ('inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens')
SIZE_UNITS = {'b': 1, 'kb': 1000, 'mb': 1000**2, 'gb': 1000**3, 'tb': 1000**4, 'kib': 1024, 'mib': 1024**2, 'gib': 1024**3, 'tib': 1024**4}


def parse_time(text):
    return datetime.fromisoformat(text.replace('Z', '+00:00'))


def utc_text(moment):
    return moment.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def minute_of(moment):
    return moment.astimezone(timezone.utc).replace(second=0, microsecond=0)


def load_prices(cost_table):
    tree = ast.parse(Path(cost_table).read_text(encoding='utf-8'))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'prices' for target in node.targets):
            return ast.literal_eval(node.value)
    raise ValueError(f'no prices table in {cost_table}')


def resolve_agent(claude_config):
    try:
        servers = json.loads(Path(claude_config).read_text(encoding='utf-8'))['mcpServers']
        url = servers['polyroom']['url']
        match = re.search(r'/bots/([^/]+)/mcp', url)
        if match:
            return match.group(1)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return socket.gethostname()


def usage_entries(projects_dir):
    for path in sorted(Path(projects_dir).rglob('*.jsonl')):
        with path.open(encoding='utf-8', errors='replace') as handle:
            for line in handle:
                if '"usage"' not in line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                message = entry.get('message')
                if not isinstance(message, dict) or message.get('role') != 'assistant':
                    continue
                usage = message.get('usage')
                stamp = entry.get('timestamp')
                model = message.get('model') or 'unknown'
                if not isinstance(usage, dict) or not stamp or model == SYNTHETIC_MODEL:
                    continue
                yield entry, message, usage, model, parse_time(stamp)


def token_values(usage):
    split = usage.get('cache_creation') if isinstance(usage.get('cache_creation'), dict) else {}
    return {
        'inputTokens': int(usage.get('input_tokens') or 0),
        'outputTokens': int(usage.get('output_tokens') or 0),
        'cacheReadTokens': int(usage.get('cache_read_input_tokens') or 0),
        'cacheWriteTokens': int(usage.get('cache_creation_input_tokens') or 0),
        'cacheWrite5mTokens': int(split.get('ephemeral_5m_input_tokens') or 0),
        'cacheWrite1hTokens': int(split.get('ephemeral_1h_input_tokens') or 0),
    }


def foreign_cwd(entry):
    cwd = entry.get('cwd')
    return isinstance(cwd, str) and not os.path.isabs(cwd)


def read_calls(projects_dir, since, until):
    calls = {}
    raw_lines = 0
    foreign_lines = 0
    for entry, message, usage, model, when in usage_entries(projects_dir):
        if when < since or when >= until:
            continue
        if foreign_cwd(entry):
            foreign_lines += 1
            continue
        raw_lines += 1
        values = token_values(usage)
        key = (message.get('id'), entry.get('requestId'))
        call = calls.get(key)
        if call is None:
            calls[key] = {'model': model, 'when': when, 'sessionId': entry.get('sessionId'), 'values': values}
            continue
        if when < call['when']:
            call['when'] = when
            call['sessionId'] = entry.get('sessionId')
        for field in TOKEN_FIELDS:
            call['values'][field] = max(call['values'][field], values[field])
    return list(calls.values()), raw_lines, foreign_lines


def first_local_call(projects_dir):
    first = None
    for entry, _, _, _, when in usage_entries(projects_dir):
        cwd = entry.get('cwd')
        if isinstance(cwd, str) and os.path.isabs(cwd) and os.path.isdir(cwd) and (first is None or when < first['when']):
            first = {'when': when, 'sessionId': entry.get('sessionId'), 'cwd': cwd}
    return first


def write_json_atomic(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(payload) + '\n', encoding='utf-8')
    os.replace(temporary, path)


def resolve_baseline(state_dir, projects_dir, override):
    if override:
        return {'at': utc_text(parse_time(override)), 'sessionId': None, 'source': 'argument'}
    stored = Path(state_dir) / BASELINE_FILE
    try:
        return json.loads(stored.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        pass
    first = first_local_call(projects_dir)
    if first is None:
        return None
    baseline = {'at': utc_text(first['when']), 'sessionId': first['sessionId'], 'cwd': first['cwd'], 'source': 'first-local-call', 'storedIn': str(stored)}
    write_json_atomic(stored, baseline)
    return baseline


def price_model(model):
    return re.sub(r'-\d{8}$', '', model)


def call_cost(model, values, prices):
    write = values['cacheWriteTokens']
    write_5m = values['cacheWrite5mTokens']
    write_1h = values['cacheWrite1hTokens']
    if write_5m + write_1h != write:
        write_1h = write - write_5m
    price = prices.get(price_model(model))
    if price is None:
        return None
    return (values['inputTokens'] * price[0] + write_5m * price[1] + write_1h * price[2] + values['cacheReadTokens'] * price[3] + values['outputTokens'] * price[4]) / 1_000_000


def empty_usage():
    return {'calls': 0, **{field: 0 for field in TOKEN_FIELDS}, 'costUsd': 0.0, 'unpricedCalls': 0}


def add_call(bucket, call, cost):
    bucket['calls'] += 1
    for field in TOKEN_FIELDS:
        bucket[field] += call['values'][field]
    if cost is None:
        bucket['unpricedCalls'] += 1
    else:
        bucket['costUsd'] += cost


def rounded(bucket):
    return {**bucket, 'costUsd': None if bucket['unpricedCalls'] == bucket['calls'] and bucket['calls'] else round(bucket['costUsd'], 6)}


def read_samples(state_dir):
    samples = {}
    invalid = 0
    path = Path(state_dir) / SAMPLES_FILE
    if not path.exists():
        return samples, invalid
    with path.open(encoding='utf-8', errors='replace') as handle:
        for line in handle:
            try:
                sample = json.loads(line)
                samples.setdefault(minute_of(parse_time(sample['takenAt'])), sample)
            except (ValueError, KeyError, TypeError, AttributeError):
                invalid += 1
    return samples, invalid


def gap_ranges(missing):
    gaps = []
    for minute in missing:
        if gaps and gaps[-1]['end'] == minute:
            gaps[-1]['end'] = minute + timedelta(minutes=1)
        else:
            gaps.append({'start': minute, 'end': minute + timedelta(minutes=1)})
    return [{'start': utc_text(gap['start']), 'end': utc_text(gap['end']), 'minutes': int((gap['end'] - gap['start']).total_seconds() // 60)} for gap in gaps]


def spread(values):
    return {'average': round(sum(values) / len(values), 3), 'peak': max(values)} if values else None


def window_samples(samples, start, end, expected_from, now):
    first = minute_of(max(start, expected_from))
    last = min(end, minute_of(now))
    expected = []
    minute = first
    while minute < last:
        expected.append(minute)
        minute += timedelta(minutes=1)
    present = [samples[minute] for minute in expected if minute in samples]
    loads = [sample['load'][0] for sample in present if isinstance(sample.get('load'), list) and sample['load']]
    memory = [sample['memory']['usedBytes'] for sample in present if isinstance(sample.get('memory'), dict) and 'usedBytes' in sample['memory']]
    return {
        'expected': len(expected),
        'received': len(present),
        'gaps': gap_ranges([minute for minute in expected if minute not in samples]),
        'load1': spread(loads),
        'memoryUsedBytes': spread(memory),
        'memoryTotalBytes': next((sample['memory'].get('totalBytes') for sample in present if isinstance(sample.get('memory'), dict)), None),
        'cores': next((sample.get('cores') for sample in present if sample.get('cores')), None),
    }


def build_report(*, day, now, projects_dir, state_dir, prices, agent, hostname, baseline_override=None, utc_offset_hours=DEFAULT_UTC_OFFSET_HOURS, window_hours=DEFAULT_WINDOW_HOURS):
    zone = timezone(timedelta(hours=utc_offset_hours))
    day_start = datetime.combine(day, datetime.min.time(), zone)
    day_end = day_start + timedelta(days=1)
    baseline = resolve_baseline(state_dir, projects_dir, baseline_override)
    baseline_at = parse_time(baseline['at']) if baseline else day_end
    calls, raw_lines, foreign_lines = read_calls(projects_dir, max(day_start, baseline_at), min(day_end, now))
    samples, invalid_samples = read_samples(state_dir)
    windows = []
    day_usage = empty_usage()
    day_minutes = set()
    day_unpriced = defaultdict(int)
    for index in range(24 // window_hours):
        start = day_start + timedelta(hours=index * window_hours)
        end = start + timedelta(hours=window_hours)
        rows = defaultdict(empty_usage)
        totals = empty_usage()
        minutes = set()
        unpriced = defaultdict(int)
        for call in calls:
            if not start <= call['when'] < end:
                continue
            cost = call_cost(call['model'], call['values'], prices)
            if cost is None:
                unpriced[call['model']] += 1
                day_unpriced[call['model']] += 1
            add_call(rows[(call['sessionId'], call['model'])], call, cost)
            add_call(totals, call, cost)
            add_call(day_usage, call, cost)
            minutes.add(minute_of(call['when']))
        day_minutes |= minutes
        windows.append({
            'start': utc_text(start),
            'end': utc_text(end),
            'localStart': start.isoformat(timespec='minutes'),
            'complete': now >= end,
            'usage': [{'agent': agent, 'hostname': hostname, 'sessionId': session, 'model': model, **rounded(bucket)} for (session, model), bucket in sorted(rows.items(), key=lambda item: (str(item[0][0]), item[0][1]))],
            'totals': rounded(totals),
            'unpriced': dict(unpriced),
            'activeMinutes': len(minutes),
            'samples': window_samples(samples, start, end, baseline_at, now),
        })
    return {
        'kind': 'report',
        'generatedAt': utc_text(now),
        'agent': agent,
        'hostname': hostname,
        'day': day.isoformat(),
        'utcOffsetHours': utc_offset_hours,
        'baseline': baseline,
        'rawUsageLines': raw_lines,
        'foreignUsageLines': foreign_lines,
        'uniqueCalls': len(calls),
        'invalidSampleLines': invalid_samples,
        'totals': rounded(day_usage),
        'unpriced': dict(day_unpriced),
        'activeMinutes': len(day_minutes),
        'windows': windows,
    }


def size_bytes(text):
    match = re.fullmatch(r'\s*([\d.]+)\s*([A-Za-z]+)\s*', text)
    if not match or match.group(2).lower() not in SIZE_UNITS:
        return None
    return int(float(match.group(1)) * SIZE_UNITS[match.group(2).lower()])


def percent(text):
    try:
        return float(text.strip().rstrip('%'))
    except (AttributeError, ValueError):
        return None


def docker_containers(docker_command, timeout_seconds):
    result = subprocess.run([docker_command, 'stats', '--no-stream', '--format', '{{json .}}'], capture_output=True, text=True, timeout=timeout_seconds, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f'docker stats exited with {result.returncode}')
    containers = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        used, _, limit = row.get('MemUsage', '').partition('/')
        containers.append({
            'name': row.get('Name'),
            'cpuPercent': percent(row.get('CPUPerc')),
            'memoryUsedBytes': size_bytes(used),
            'memoryLimitBytes': size_bytes(limit),
            'memoryPercent': percent(row.get('MemPerc')),
        })
    return containers


def memory_info():
    values = {}
    with open('/proc/meminfo', encoding='utf-8') as handle:
        for line in handle:
            name, _, rest = line.partition(':')
            values[name] = int(rest.split()[0]) * 1024
    return {'usedBytes': values['MemTotal'] - values['MemAvailable'], 'totalBytes': values['MemTotal']}


def take_sample(*, now, hostname, agent, disk_path, docker_command, docker_timeout_seconds):
    sample = {'kind': 'sample', 'takenAt': utc_text(now), 'hostname': hostname, 'agent': agent, 'cores': os.cpu_count()}
    errors = []
    probes = (
        ('load', lambda: [round(value, 2) for value in os.getloadavg()]),
        ('memory', memory_info),
        ('disk', lambda: {key: getattr(usage, key) for usage in [shutil.disk_usage(disk_path)] for key in ('total', 'used', 'free')}),
        ('docker', lambda: docker_containers(docker_command, docker_timeout_seconds)),
    )
    for name, probe in probes:
        try:
            sample[name] = probe()
        except Exception as error:
            sample[name] = None
            errors.append({'probe': name, 'error': f'{type(error).__name__}: {error}'})
    sample['errors'] = errors
    return sample


def append_sample(state_dir, sample):
    path = Path(state_dir) / SAMPLES_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as handle:
        handle.write(json.dumps(sample) + '\n')


def parse_arguments(argv):
    parser = argparse.ArgumentParser(description='Machine cost snapshot: per-minute samples and a daily report in fixed windows.')
    parser.add_argument('--state-dir', default=str(DEFAULT_STATE_DIR))
    parser.add_argument('--agent')
    parser.add_argument('--claude-config', default=str(DEFAULT_CLAUDE_CONFIG))
    commands = parser.add_subparsers(dest='command', required=True)
    sample = commands.add_parser('sample')
    sample.add_argument('--disk-path', default=DEFAULT_DISK_PATH)
    sample.add_argument('--docker-command', default=DEFAULT_DOCKER_COMMAND)
    sample.add_argument('--docker-timeout-seconds', type=float, default=DEFAULT_DOCKER_TIMEOUT_SECONDS)
    report = commands.add_parser('report')
    report.add_argument('--day', type=date.fromisoformat)
    report.add_argument('--now', type=parse_time)
    report.add_argument('--projects-dir', default=str(DEFAULT_PROJECTS_DIR))
    report.add_argument('--cost-table', default=str(DEFAULT_COST_TABLE))
    report.add_argument('--baseline')
    report.add_argument('--utc-offset-hours', type=int, default=DEFAULT_UTC_OFFSET_HOURS)
    report.add_argument('--window-hours', type=int, choices=[1, 2, 3, 4, 6, 8, 12, 24], default=DEFAULT_WINDOW_HOURS)
    return parser.parse_args(argv)


def main(argv=None):
    arguments = parse_arguments(argv)
    hostname = socket.gethostname()
    agent = arguments.agent or resolve_agent(arguments.claude_config)
    if arguments.command == 'sample':
        now = datetime.now(timezone.utc)
        try:
            sample = take_sample(now=now, hostname=hostname, agent=agent, disk_path=arguments.disk_path, docker_command=arguments.docker_command, docker_timeout_seconds=arguments.docker_timeout_seconds)
        except Exception as error:
            sample = {'kind': 'sample', 'takenAt': utc_text(now), 'hostname': hostname, 'agent': agent, 'errors': [{'probe': 'sample', 'error': f'{type(error).__name__}: {error}'}]}
        append_sample(arguments.state_dir, sample)
        return 0
    now = arguments.now or datetime.now(timezone.utc)
    zone = timezone(timedelta(hours=arguments.utc_offset_hours))
    report = build_report(
        day=arguments.day or now.astimezone(zone).date(),
        now=now,
        projects_dir=arguments.projects_dir,
        state_dir=arguments.state_dir,
        prices=load_prices(arguments.cost_table),
        agent=agent,
        hostname=hostname,
        baseline_override=arguments.baseline,
        utc_offset_hours=arguments.utc_offset_hours,
        window_hours=arguments.window_hours,
    )
    print(json.dumps(report))
    return 0


if __name__ == '__main__':
    sys.exit(main())
