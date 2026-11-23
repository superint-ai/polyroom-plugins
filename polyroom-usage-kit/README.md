# polyroom usage kit for Claude Code

Scripts that watch how much a Claude Code machine uses: the context of the session, the 5-hour window and the weekly limit of the plan, and the cost of each call at API prices. When a limit crosses a threshold, the kit posts one alert to a polyroom room, through the polyroom MCP server of that machine.

It is built for a Linux machine that runs Claude Code as an agent all day. Everything runs as root, from cron.

## What's in it

- `install.sh`: installs the kit, sets the status line in the Claude Code settings and adds the two cron jobs.
- `statusline-capture.sh`: the status line command. It keeps the last status line payload of each session and then shows the status line of [claude-monitor](https://pypi.org/project/claude-monitor/).
- `usage-check.py`: reads those captures and posts an alert to polyroom once per threshold crossing.
- `token-usage/snapshot.py`: a per-minute machine sample (CPU, memory, disk, Docker) and a daily report of tokens and cost per session, in fixed windows.
- `token-usage/cost.py`: tokens and API-equivalent cost per profile and day, read from the Claude Code transcripts. It also holds the price table that `snapshot.py` reads.
- `token-usage/test_snapshot.py`: the tests of `snapshot.py`.

## Requirements

- Linux with root, `crontab`, `python3` and `jq` (the installer adds `jq` and `python3-venv` with apt when they are missing).
- Claude Code on the same machine, signed in with a plan that reports its rate limits to the status line.
- For the alerts: the polyroom MCP server added to Claude Code under the name `polyroom`, so `~/.claude.json` has its address and sign-in. Without it the kit still measures; it just cannot post.

## Install

Copy this folder to the machine and run, as root:

```
./install.sh --room <polyroom room id> --mention-handle <agent handle>
```

Options:

- `--room`: the room that gets the alerts. Required.
- `--mention-handle <handle>` or `--mention-person <person id>`: who the alert mentions. At least one; repeat for more.
- `--kit-dir <folder>`: where the kit is installed. Default `/opt/polyroom-usage-kit`.
- `--auto-compact-window <tokens>`: the `autoCompactWindow` written to the settings, globally and for each model. Default `300000`.
- `--compact-model <model id>`: a model that gets that window in `modelSettings`. Default `claude-opus-5-5`; repeat for more.
- `--disable-claude-ai-connectors`: also sets `disableClaudeAiConnectors` to true, so the session does not load the connectors of the claude.ai account.

What the installer changes:

- installs `claude-monitor` 4.0.0 in a virtual environment at `/opt/claude-monitor-venv`;
- copies the kit to the kit folder;
- in `settings.json` of Claude Code (`$CLAUDE_CONFIG_DIR`, or `~/.claude`), sets `statusLine` to `statusline-capture.sh` and the compaction window, after a copy of the file in `settings.json.before-usage-kit`;
- adds two cron lines, tagged `# polyroom-cost-sample` and `# polyroom-usage-check`, with logs in `/var/log/polyroom-cost-sample.log` and `/var/log/polyroom-usage-check.log`.

Running it again replaces the two cron lines and keeps the rest of the crontab.

The first context reading appears after the next Claude Code turn on the machine.

## Usage check

`usage-check.py` runs at minutes 7, 22, 37 and 52 of every hour. Each run prints one line, appends a record to `~/.claude-monitor/usage-check-history.jsonl` and posts the alerts that are new since the last run. An alert that is still active is not posted again; it comes back only after it clears and crosses again. A failed post is retried on the next run.

It alerts when:

- the context of the session passes 400k or 600k tokens (`--context-token-levels`);
- the 5-hour window passes 80% or 95% (`--five-hour-levels`);
- the week passes 70%, 85% or 95% (`--week-levels`);
- the week is 15 points ahead of a linear pace (`--week-pace-margin`);
- the pace of the last 6 hours takes the week to 90% before it resets (`--week-projection-level`, `--week-projection-window-hours`);
- the status line capture or the claude-monitor reading stops.

To see the reading without posting or saving anything:

```
python3 /opt/polyroom-usage-kit/usage-check.py --dry-run
```

The alerts are written in Brazilian Portuguese, with times in BRT (UTC−3).

## Cost per day

```
python3 token-usage/cost.py 2026-11-01T00:00:00+00:00 --root main=~/.claude/projects
```

- `--root NAME=PATH`: a Claude Code projects folder and the name of its profile. Repeat it to compare several profiles; a call copied into more than one folder counts once.
- `--base-profile NAME`: the profile that keeps a copied call. Default: the first `--root`.
- `--utc-offset-hours`: the offset that decides the day of each call. Default `-3`.
- `--split-subagents`: subagent calls on their own rows.
- `--buckets`: cost per context size instead of the daily rows.

The prices are API list prices per million tokens, in the `prices` table at the top of `cost.py`. A model missing from the table is listed under `unpriced` and never counts as zero.

## Machine report

```
python3 token-usage/snapshot.py report --day 2026-11-22
```

It reads the per-minute samples in `~/.cache/polyroom-cost` and the transcripts in `~/.claude/projects`, and prints the report as JSON. `--window-hours` sets the window size and `--utc-offset-hours` the day boundary.

Tests:

```
python3 -m unittest discover -s token-usage -p 'test_snapshot.py'
```

## Remove

```
crontab -l | grep -v -e '# polyroom-cost-sample' -e '# polyroom-usage-check' | crontab -
```

Then restore `settings.json` from `settings.json.before-usage-kit` and delete the kit folder.
