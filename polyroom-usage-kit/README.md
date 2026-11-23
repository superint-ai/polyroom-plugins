# polyroom usage kit for Claude Code

Scripts that watch how much a Claude Code machine uses: the context of the session, the 5-hour window and the weekly limit of the plan, and the cost of each call at API prices. When a limit crosses a threshold, the kit posts one alert to a polyroom room, through the polyroom MCP server of that machine.

It is built for a Linux machine that runs Claude Code as an agent all day. Everything runs as root, from cron.

## What's in it

- `install.sh`: installs the kit, sets the status line in the Claude Code settings and adds the two cron jobs.
- `statusline-capture.sh`: the status line command. It keeps the last status line payload of each session and then shows the status line of [claude-monitor](https://pypi.org/project/claude-monitor/).
- `usage-check.py`: reads those captures and posts an alert to polyroom once per threshold crossing.
- `token-usage/snapshot.py`: a per-minute machine sample (CPU, memory, disk, Docker) and a daily report of tokens and cost per session, in fixed windows.
- `token-usage/cost.py`: tokens and API-equivalent cost per profile and day, read from the Claude Code transcripts. It also holds the price table that `snapshot.py` reads.
- `test_install.py`, `test_usage_check.py`, `token-usage/test_cost.py` and `token-usage/test_snapshot.py`: the tests. They run with stand-ins for `crontab`, `apt-get` and the polyroom server, in temporary folders: they change nothing on the machine.

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
- `--venv <folder>`: the virtual environment of `claude-monitor`. Default `/opt/claude-monitor-venv`.
- `--auto-compact-window <tokens>`: the `autoCompactWindow` written to the settings, globally and for each model. Default `300000`.
- `--compact-model <model id>`: a model that gets that window in `modelSettings`. Default `claude-opus-5-5`; repeat for more.
- `--disable-claude-ai-connectors`: also sets `disableClaudeAiConnectors` to true, so the session does not load the connectors of the claude.ai account.

The values go into the root crontab, so the installer checks each one before it changes anything and stops with exit code 64 when one does not fit: room and person ids are UUIDs; a handle is a letter followed by letters, digits, `_` or `-`, with an optional `@`; folders are absolute paths of letters, digits, `.`, `_`, `-` and `/`; a model id has letters, digits, `.`, `_` and `-`; the window is a whole number.

What the installer changes:

- installs with apt only what is missing: `jq`, and `python3-venv` with `python3-pip` when the virtual environment has to be created and Python cannot create it;
- installs `claude-monitor` 4.0.0 in the virtual environment, unless it is already there, and links it as `claude-monitor` in the kit folder, where the status line command finds it;
- copies the kit to the kit folder;
- in `settings.json` of Claude Code (`$CLAUDE_CONFIG_DIR`, or `~/.claude`), sets `statusLine` to `statusline-capture.sh` and the compaction window. The first install keeps a copy of the file as it was in `settings.json.before-usage-kit`; later installs keep that copy. The edit is written to a new file with the owner and mode of the original and then moved over it, so a failed edit leaves the original as it was;
- adds two cron lines, tagged `# polyroom-cost-sample` and `# polyroom-usage-check`, with logs in `/var/log/polyroom-cost-sample.log` and `/var/log/polyroom-usage-check.log`.

Running it again replaces the two cron lines and keeps the rest of the crontab.

The first context reading appears after the next Claude Code turn on the machine.

## Usage check

`usage-check.py` runs at minutes 7, 22, 37 and 52 of every hour. Each run prints one line, appends a record to `~/.claude-monitor/usage-check-history.jsonl` and posts the alerts that are new since the last run.

- Each level is tracked on its own. A level alerts once when the reading crosses it and comes back only after the reading drops below it and crosses again. When one run crosses several levels of the same reading, the message shows only the highest, and the lower ones count as sent with it.
- A failed post is retried on the next run with the same message id and the same text, so the room gets one message even when the server saved the first try and its answer was lost. The retry goes out first and as it was, even when its alert cleared or new alerts appeared in the meantime; the new alerts go in a message of their own. A new crossing after the alert cleared is a new message.
- A reading older than `--capture-max-age-minutes` (default 360) is not current: a stale status line capture alerts once and its context is not used, and a stale claude-monitor reading gives no limit. The alerts that were active stay active, without a new post, until a current reading arrives.
- When the history is too short to project the week, the projection alert keeps its previous state.

It alerts when:

- the context of the session passes 400k or 600k tokens (`--context-token-levels`);
- the 5-hour window passes 80% or 95% (`--five-hour-levels`);
- the week passes 70%, 85% or 95% (`--week-levels`);
- the week is 15 points ahead of a linear pace (`--week-pace-margin`);
- the pace of the last 6 hours takes the week to 90% before it resets (`--week-projection-level`, `--week-projection-window-hours`);
- the status line capture is missing or stale, or the claude-monitor reading falls more than 10 minutes behind it.

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

The prices are API list prices per million tokens, in the `prices` table at the top of `cost.py`. A model missing from the table is listed under `unpriced` and never counts as zero; with `--buckets`, the last line counts those calls per model and says that the total leaves them out.

## Machine report

```
python3 token-usage/snapshot.py report --day 2026-11-22
```

It reads the per-minute samples in `~/.cache/polyroom-cost` and the transcripts in `~/.claude/projects`, and prints the report as JSON. `--window-hours` sets the window size and `--utc-offset-hours` the day boundary.

## Tests

From the kit folder:

```
python3 -m unittest discover -s . -p 'test_*.py'
python3 -m unittest discover -s token-usage -p 'test_*.py'
```

## Remove

```
crontab -l | grep -v -e '# polyroom-cost-sample' -e '# polyroom-usage-check' | crontab -
```

Then restore `settings.json` from `settings.json.before-usage-kit` and delete the kit folder.
