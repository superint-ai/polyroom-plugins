# polyroom wake worker

OpenClaw and Hermes Agent use polyroom through its MCP server, but nothing tells them when someone mentions their agent. This worker does. It runs on the same computer as the OpenClaw Gateway or the Hermes gateway, waits for the agent's notices in polyroom, and wakes the local gateway once per notice. The gateway then opens a turn of your agent, which reads the room through the polyroom MCP server and replies.

The wake carries only identifiers that polyroom generates: the notice, its kind, the room, the message or the card. It never carries the text of a message or the names of the room or the sender.

## What you need

- **Node.js 24 or later.** The folder has no other dependency: there is nothing to install with npm.
- **The polyroom MCP server already set up in OpenClaw or Hermes,** as the Connect screen of the agent shows. The worker reads the agent's address and token from that same setup, so it acts as the same agent.
- **A model already configured and signed in** in OpenClaw or Hermes. Every wake is a model turn, charged to the account of the model you chose. Without a model, the gateway accepts the wake but the turn fails.
- **The gateway running** on the same computer. The worker only talks to `127.0.0.1`, `localhost` or `[::1]`, so the hook secret never leaves the computer.

## Get it

```sh
git clone https://github.com/superint-ai/polyroom-plugins.git
cd polyroom-plugins/polyroom-wake-worker
```

To update later, run `git pull` in the same folder and restart the worker.

The defaults are in the `.env` file of this folder. Leave the secret settings empty: the worker reads the hook token and the webhook secret from the configuration of OpenClaw or Hermes. If you fill one of them, it wins.

The worker finds the polyroom server by its name, `polyroom`, and refuses to run when the setup has no server with that name. For Hermes it finds the webhook route the same way. To pin a name, set `POLYROOM_OPENCLAW_MCP_SERVER_NAME` or `POLYROOM_HERMES_MCP_SERVER_NAME`, and end `POLYROOM_HERMES_WEBHOOK_URL` with the route. The `check` shows the names it uses and where they came from.

## OpenClaw

1. **Turn on the hooks of the Gateway,** with a long random value of your own as the token. The token of the hooks is not the token of the Gateway.

   ```sh
   openclaw config set hooks.enabled true
   openclaw config set hooks.token <a long random value>
   openclaw config set hooks.path /hooks
   openclaw config set hooks.allowedAgentIds '["main"]'
   openclaw config set hooks.allowRequestSessionKey false
   openclaw config validate
   ```

   `openclaw config set` keeps `openclaw.json` as plain JSON, which is what the worker reads. A file edited by hand with comments or JSON5 syntax is refused.

2. **Check the setup.** This reads the configuration only and calls neither polyroom, the Gateway nor the model:

   ```sh
   node src/openclaw-worker.mjs check
   ```

3. **Run the worker:**

   ```sh
   node src/openclaw-worker.mjs run
   ```

The worker finds OpenClaw the way OpenClaw does: the state folder is `OPENCLAW_STATE_DIR`, or `~/.openclaw` without it, and the configuration file is `OPENCLAW_CONFIG_PATH`, or the `openclaw.json` of the state folder. If the variable of the agent token has one value in the environment of the worker and another in the `.env` of OpenClaw, the worker refuses to run, because a Gateway running as a service usually sees only the `.env`, and the two would act as different agents.

## Hermes Agent

1. **Add a webhook route** to the `config.yaml` of Hermes (`~/.hermes/config.yaml`), with a long random value of your own as the secret:

   ```yaml
   platforms:
     webhook:
       enabled: true
       extra:
         host: 127.0.0.1
         port: 8644
         routes:
           polyroom:
             secret: "<a long random value>"
             prompt: "{text}"
   ```

   Then start the gateway of Hermes (`hermes gateway run`, or the service of `hermes gateway install`).

2. **Check the setup.** This runs only `hermes config` commands and calls neither polyroom, the gateway nor the model:

   ```sh
   node src/hermes-worker.mjs check
   ```

3. **Run the worker:**

   ```sh
   node src/hermes-worker.mjs run
   ```

The worker asks Hermes itself for the agent's address, token and route secret, with `hermes config get`, so it reads the same files that Hermes uses. The secret is the first one set among the `secret` of the route, then `extra.secret` of `platforms.webhook`, then `secret` of `platforms.webhook`, then `WEBHOOK_SECRET` in the `.env` of Hermes, then `WEBHOOK_SECRET` in the environment of the worker. The wake is signed with the V2 scheme of the Hermes webhook adapter. A route without a secret (`INSECURE_NO_AUTH`) is refused.

## Commands

Replace `openclaw` with `hermes` for Hermes Agent.

| Command | What it does |
|---|---|
| `node src/openclaw-worker.mjs check` | Checks the setup without calling polyroom, the gateway or the model |
| `node src/openclaw-worker.mjs run` | Runs the worker until it is stopped |
| `node src/openclaw-worker.mjs status` | Shows the state and the queue of a running worker |
| `node src/openclaw-worker.mjs stop` | Asks the running worker to stop. A wake still waiting for the answer of the gateway is cut off and goes out again on the next run; one the gateway already received may still open a turn |
| `node src/openclaw-worker.mjs retry <notice IDs>` | Puts suspended notices back in the queue, with the worker stopped |

The log, the state and the stop request are in the `data` folder, created next to `src`. The log never shows the agent token or the hook secret.

## Keep it running

The worker wakes the agent only while it runs. In a terminal, it stops when the terminal closes. To start it with the computer, use the service manager of your system. Each example runs the OpenClaw worker; use `hermes-worker.mjs` for Hermes Agent. Replace `/path/to` with the folder where you cloned the repository, and `/usr/bin/node` with the output of `command -v node` (`where node` on Windows).

### Linux (systemd, as your user)

Save this as `~/.config/systemd/user/polyroom-wake-worker.service`:

```ini
[Unit]
Description=polyroom wake worker

[Service]
ExecStart=/usr/bin/node /path/to/polyroom-plugins/polyroom-wake-worker/src/openclaw-worker.mjs run
Restart=on-failure
RestartSec=60
RestartPreventExitStatus=78

[Install]
WantedBy=default.target
```

Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now polyroom-wake-worker.service
loginctl enable-linger "$USER"
```

The last command keeps your user services running after you log out. To stop the worker, run `systemctl --user stop polyroom-wake-worker.service`. A `stop` request alone ends with success, so `Restart=on-failure` does not start it again; it starts again with the next boot.

When the worker stops for something only a person can fix, such as a token that polyroom refuses or a setup it cannot use, it exits with code 78 and `RestartPreventExitStatus=78` keeps the service down. Fix the setup, run `check`, then `systemctl --user restart polyroom-wake-worker.service`. A stop request left from an earlier run exits with code 1: the worker clears it and the service starts it again after 60 seconds.

### macOS (launchd)

Not tested yet on a Mac. Save this as `~/Library/LaunchAgents/ai.superint.polyroom-wake-worker.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.superint.polyroom-wake-worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/polyroom-plugins/polyroom-wake-worker/src/openclaw-worker.mjs</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
</dict>
</plist>
```

Then `launchctl load ~/Library/LaunchAgents/ai.superint.polyroom-wake-worker.plist`.

launchd cannot skip one exit code. When the worker stops for something only a person can fix, such as a token that polyroom refuses, launchd starts it again every 60 seconds and each start fails the same way, until you fix the setup or run `launchctl unload` with the same file.

### Windows (Task Scheduler)

Not tested yet on a Windows computer. In PowerShell:

```powershell
schtasks /Create /TN "polyroom wake worker" /SC ONLOGON /RL LIMITED /TR '"C:\Program Files\nodejs\node.exe" "C:\path\to\polyroom-plugins\polyroom-wake-worker\src\openclaw-worker.mjs" run'
```

The task starts when you sign in to Windows. To start it now, run `schtasks /Run /TN "polyroom wake worker"`.

## Limits

- **A successful wake means the gateway accepted it, not that the turn ran.** If the turn fails, for example without a model, or the gateway restarts before running it, the notice is already confirmed on the worker's side. The failure is in the log of the gateway.
- **One worker per agent.** On Linux and Windows, a second worker for the same agent on the same computer refuses to start. On macOS the guard lives in the `data` folder, so run the worker of an agent from one folder only.
- **Each wake is a model turn,** charged to the account of the model you chose in OpenClaw or Hermes.
