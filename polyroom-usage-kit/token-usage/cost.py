import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

prices = {
    'claude-opus-5-5': (4.0, 5.0, 8.0, 0.20, 20.0),
    'claude-sonnet-5-5': (2.0, 2.5, 4.0, 0.20, 10.0),
    'claude-fable-5-1': (10.0, 12.5, 20.0, 0.25, 50.0),
    'claude-haiku-4-5': (1.0, 1.25, 2.0, 0.10, 5.0),
}
fields = ('fresh', 'out', 'read', 'write', 'write_5m', 'write_1h')

edges = [50_000, 100_000, 200_000, 300_000, 400_000, 600_000, 800_000, 10**9]
labels = ['<50k', '50-100k', '100-200k', '200-300k', '300-400k', '400-600k', '600-800k', '>800k']

parser = argparse.ArgumentParser(description='Claude Code API-equivalent cost per profile and day, read from the session transcripts.')
parser.add_argument('since', type=datetime.fromisoformat, help='ISO start, inclusive')
parser.add_argument('until', nargs='?', type=datetime.fromisoformat, help='ISO end, exclusive; default: now')
parser.add_argument('--root', action='append', default=[], metavar='NAME=PATH', help='a Claude Code projects folder and the profile name to report it under; repeat for each profile; default: default=~/.claude/projects')
parser.add_argument('--base-profile', help='profile that keeps a call found in several profiles; default: the first --root')
parser.add_argument('--utc-offset-hours', type=int, default=-3, help='offset that decides the day of each call')
parser.add_argument('--split-subagents', action='store_true', help='report subagent calls on their own rows')
parser.add_argument('--buckets', action='store_true', help='print cost per context size instead of the daily rows')
arguments = parser.parse_args()
roots = {}
for item in arguments.root:
    name, separator, folder = item.partition('=')
    if not separator or not name or not folder:
        parser.error(f'--root needs NAME=PATH, got {item!r}')
    roots[name] = os.path.expanduser(folder)
if not roots:
    roots['default'] = str(Path.home() / '.claude' / 'projects')
base_profile = arguments.base_profile or next(iter(roots))
if base_profile not in roots:
    parser.error(f'--base-profile {base_profile!r} is not a --root name')
day_zone = timezone(timedelta(hours=arguments.utc_offset_hours))
since = arguments.since
until = arguments.until or datetime.now(timezone.utc)
split_subagents = arguments.split_subagents
calls = {}

for agent, root in roots.items():
    for directory, _, names in os.walk(root):
        for name in names:
            if not name.endswith('.jsonl'):
                continue
            path = os.path.join(directory, name)
            in_subagent = 'subagents' in os.path.normpath(path).split(os.sep)
            with open(path, encoding='utf-8', errors='replace') as handle:
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
                    if not isinstance(usage, dict) or not stamp or model == '<synthetic>':
                        continue
                    when = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
                    if when < since or when >= until:
                        continue
                    split = usage.get('cache_creation') if isinstance(usage.get('cache_creation'), dict) else {}
                    values = {
                        'fresh': int(usage.get('input_tokens') or 0),
                        'out': int(usage.get('output_tokens') or 0),
                        'read': int(usage.get('cache_read_input_tokens') or 0),
                        'write': int(usage.get('cache_creation_input_tokens') or 0),
                        'write_5m': int(split.get('ephemeral_5m_input_tokens') or 0),
                        'write_1h': int(split.get('ephemeral_1h_input_tokens') or 0),
                    }
                    key = (message.get('id'), entry.get('requestId'))
                    call = calls.get(key)
                    if call is None:
                        calls[key] = {'agents': {agent}, 'model': model, 'when': when, 'values': values, 'subagent': in_subagent}
                        continue
                    call['agents'].add(agent)
                    call['subagent'] = call['subagent'] and in_subagent
                    call['when'] = min(call['when'], when)
                    for field in fields:
                        call['values'][field] = max(call['values'][field], values[field])

per_agent_day = defaultdict(lambda: defaultdict(float))
minutes = defaultdict(set)
unpriced = defaultdict(int)
context = defaultdict(lambda: defaultdict(float))

for call in calls.values():
    agents = call['agents']
    copied = len(agents) > 1
    agent = base_profile if copied and base_profile in agents else sorted(agents)[0]
    values = call['values']
    fresh, out, read, write, write_5m, write_1h = (values[field] for field in fields)
    if write_5m + write_1h != write:
        write_1h = write - write_5m
    model = call['model']
    price = prices.get(re.sub(r'-\d{8}$', '', model))
    day = call['when'].astimezone(day_zone).strftime('%Y-%m-%d')
    label = agent + (' (subagents)' if split_subagents and call['subagent'] else '')
    bucket = per_agent_day[(label, day)]
    bucket['calls'] += 1
    bucket['copiedCalls'] += 1 if copied else 0
    bucket['fresh'] += fresh
    bucket['out'] += out
    bucket['read'] += read
    bucket['write'] += write
    if not copied:
        minutes[(label, day)].add(call['when'].strftime('%Y-%m-%dT%H:%M'))
    if price is None:
        unpriced[model] += 1
        continue
    cost = (fresh * price[0] + write_5m * price[1] + write_1h * price[2] + read * price[3] + out * price[4]) / 1_000_000
    bucket['cost'] += cost
    bucket['cost_read'] += read * price[3] / 1_000_000
    bucket['cost_out'] += out * price[4] / 1_000_000
    bucket['cost_write'] += (write_5m * price[1] + write_1h * price[2]) / 1_000_000
    prompt = fresh + read + write
    size = context[labels[next(i for i, edge in enumerate(edges) if prompt < edge)]]
    size['calls'] += 1
    size['cost'] += cost
    size['prompt'] += prompt

if arguments.buckets:
    total = sum(size['cost'] for size in context.values())
    count = sum(size['calls'] for size in context.values())
    for label in labels:
        size = context[label]
        if size['calls']:
            print(f"{label:>9} calls {int(size['calls']):6d} ({100 * size['calls'] / count:4.1f}%)  cost {size['cost']:8.0f} ({100 * size['cost'] / total:4.1f}%)  per call {size['cost'] / size['calls']:.3f}  avg ctx {size['prompt'] / size['calls'] / 1000:.0f}k")
    print('total', round(total), 'calls', int(count))
    sys.exit(0)

rows = []
for (agent, day), bucket in sorted(per_agent_day.items()):
    rows.append({'agent': agent, 'day': day, 'activeMinutes': len(minutes[(agent, day)]), **{k: round(v, 4) for k, v in bucket.items()}})
json.dump({'since': since.isoformat(), 'until': until.isoformat(), 'unpriced': unpriced, 'rows': rows}, sys.stdout, indent=1)
