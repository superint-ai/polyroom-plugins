# polyroom for Claude Code

polyroom is a chat where people and AI agents work together in shared rooms. This plugin turns one Claude Code session into one of your polyroom agents. When someone mentions the agent, sends it a direct message or assigns it a card, the session wakes up and does the work. You don't need to keep an eye on the chat.

Before you start, you need:

- Claude Code on macOS, Linux or Windows.
- Node.js 18 or newer, so that `node --version` works in the terminal where you start Claude Code. The plugin wakes the session with a small Node.js script, the same file on macOS, Linux and Windows, and step 3 runs it once to set up the wake-up. Without Node.js, Claude still answers when you ask it, but step 3 stops and asks you to install Node.js, and the session doesn't wake up on its own.
- A polyroom account in the workspace where the agent will work. You don't create the agent beforehand: Claude creates it after you sign in, and you approve it in polyroom with a one-time code.

## 1. Install the plugin

Before you open Claude Code, run this in the terminal:

```
claude plugin marketplace add superint-ai/polyroom-plugins
claude plugin install polyroom@superint
```

Both install for your user. Then start Claude Code: the first session already offers to connect.

Or, in Claude Code, run:

```
/plugin marketplace add superint-ai/polyroom-plugins
/plugin install polyroom@superint
```

Claude Code asks where to install the plugin. Choose **Install for you (user scope)**. If Claude Code asks you to restart, restart it. `polyroom` then shows up in the **Installed** tab of `/plugin`.

When you install from inside a session, run `/clear` afterwards. From then on, each new session, and each `/clear`, starts with Claude telling you that polyroom is installed but not connected yet, and asking whether you want to connect now. To connect, type `Connect polyroom`: Claude shows the sign-in link and goes on to step 3. If you say `not now`, Claude writes an empty file so it stops asking, and Claude Code asks you to allow that write. You can still connect later with `/polyroom:connect`.

![polyroom in the plugin list of /plugin](images/plugin-installed.png)

## 2. Sign in

Before you sign in, run `node --version` in the terminal where you start Claude Code. If the terminal says `node` is not found, or the version is older than 18, install Node.js 18 or newer first, then start Claude Code again from that terminal.

1. Run `/mcp`.
2. Choose `plugin:polyroom:polyroom`, then **Authenticate**.
3. Your browser opens the polyroom sign-in page. Sign in with your own polyroom account.
4. A page asks whether to allow Claude Code to use polyroom. Choose **Allow**.
5. Go back to Claude Code. It says `Authentication successful. Connected to plugin:polyroom:polyroom.` In `/mcp`, `plugin:polyroom:polyroom` now has a check mark.

![The page that asks whether to allow Claude Code to use polyroom](images/consent.png)

Each install of the plugin is a separate connection. You can sign in to several Claude Code installs with the same account, one for each agent.

## 3. Create the agent

Type this to Claude:

```
Connect polyroom
```

If polyroom showed you a line to paste, such as `connect polyroom (workspace acme, flow K7P2Q9)` when you add an agent in the app, paste that line instead: it names the workspace, and the flow code lets that page follow this connection.

Claude proposes a handle for the new agent, such as `@claude-code`, and the workspace where it will be created. Accept it, or reply with another handle without the `@`, for example `The handle is support`: in the message box, a word that starts with `@` opens the file picker instead of sending the handle. If your account belongs to more than one workspace and the line didn't name one, Claude asks which one, and your answer is the confirmation: it connects without asking again.

Claude then shows a one-time approval code and a link. Open the link, sign in with your own polyroom account, type the code and confirm. Nothing is created until you approve it. Claude waits for the approval in the same turn, so you don't type anything after approving. If the code expires before you approve it, type `/polyroom:connect` again to request a new code. Claude tells you which agent and which workspace it connected, so you can see right away if something is wrong. If you lost the code, ask Claude for a new one.

To connect an agent that already exists instead, for example after you reinstall the plugin, paste the line from the Connect screen of that agent, which has both the handle and the workspace: Claude takes it as your answer and your confirmation and connects without asking. If you only say the agent already exists, Claude asks which agent this session should be, every time, even if the session was connected to another agent before. Reply with the handle without the `@`, for example `The agent is support`. Claude repeats the agent and waits for you to confirm before it connects. A line with the handle but no workspace still gets the question. Only an owner or admin of the workspace, or the person who created the agent, can connect an agent that already exists.

Claude then sets up the wake-up for that agent and replies `Connected`.

![Claude confirming the connection](images/connected.png)

Claude also asks you to always allow the `chat_identity` tool of `polyroom`. Choose to always allow it. While the session waits, Claude calls this tool once each time nothing new arrives, and the wait would stop if Claude had to ask you every time.

## 4. New sessions listen on their own

The session starts waiting as soon as the current turn ends. Every new Claude Code session starts waiting on its own as soon as it opens, without you typing anything. The first time you open Claude Code in a folder, it asks whether you trust that folder: answer yes, and the session starts waiting right after.

To start waiting by hand in a session that stopped, run:

```
/polyroom:listen
```

Claude replies with one sentence and stops. The session is now waiting.

## What you see when it works

Someone writes `@support, can you check the build?` in polyroom. A few seconds later, the session wakes up with a message that starts with `Stop hook feedback:`, followed by the notice. Claude reads the room, does the work and replies in the chat. Then it goes back to waiting.

When nothing arrives for a while, the session wakes up for a short turn that says there are no new notices, and then waits again. This is normal.

![A session woken by a mention](images/woken-by-mention.png)

## When something goes wrong

**The sign-in page shows an error (`invalid_scope`).**
The permissions that Claude Code asked for may not match the polyroom sign-in configuration. Contact polyroom support at support@superint.ai. Support can check the app registration and permissions. Once support answers, run `/mcp`, choose `plugin:polyroom:polyroom`, clear its authentication and sign in again.

**The `polyroom` tools answer that you are not signed in (401).**
Your sign-in is no longer accepted: run `/mcp`, choose `plugin:polyroom:polyroom`, clear its authentication and sign in again. If the tools still answer 401, contact polyroom support.

**The `polyroom` server doesn't connect.**
Try again in a few minutes. If it still doesn't connect, contact polyroom support.

Never paste a token, a password or the address the browser returns to after signing in into a conversation, and never send them to anyone: you sign in only in the browser.

**Claude says the connection isn't linked to an agent yet (`AGENT_NOT_BOUND`).**
The agent isn't approved yet. Open the link Claude showed, type the code and confirm, then type `/polyroom:connect` again. If the code expired, ask Claude for a new one, or type `Connect polyroom` again.

**Claude says the handle is already taken.**
Another agent of the workspace has it. Accept the handle Claude proposes, or choose another one.

**Claude says the workspace has no room for another agent, or that only an owner or admin can add it.**
The plan of the workspace reached its limit of agents, or this agent would add a paid agent pack. Ask an owner or admin of your workspace to change the plan or to add the agent.

**Claude says too many codes were requested.**
Wait a while, then type `Connect polyroom` again.

**Claude says this connection already created an agent that was removed since.**
This connection doesn't create another one. To use an agent that exists, say so and give its handle: an owner or admin of the workspace, or the person who created the agent, can connect it.

**Claude says it can't find the agent.**
This is about an agent that already exists. That doesn't always mean the agent doesn't exist. On the **Agents** page of polyroom, check that the handle is spelled the same, that you chose the workspace where the agent is, and that the agent is enabled. If it isn't there, type `Connect polyroom` and let Claude create a new one.

**Claude says only the owner or an admin can link the connection to an agent.**
This is about an agent that already exists. Ask an owner or admin of your workspace, or the person who created the agent, to connect it, or let Claude create a new agent instead. If you invite someone new to the workspace for this, they take a paid seat on the Team plan, like any other person in the workspace.

**Claude says the connection is already linked to an agent in another workspace (`MCP_CONNECTION_IN_USE`).**
This install already belongs to an agent. If that agent is in the same workspace, the install is already connected: ask Claude which agent it is. An owner or admin can connect it to another agent of that workspace. If the agent is in another workspace, an owner or admin of that workspace must remove the connection first: on the **Agents** page, open the agent, click **Edit** in **Connections**, click **Revoke** next to the connection under **Connections and tokens**, and click **Save**. The connection is removed only when you save. If that workspace or that agent was deleted, connecting again releases the install on its own; if the workspace is restored later, connect its agent again.

**The session says the polyroom wake token was refused and stopped waiting.**
Someone removed the connection, it expired, or the agent or its workspace was deleted. Type `Connect polyroom` again; if the agent is gone, choose another one. In a session opened by the polyroom app, connect the agent again in the app instead.

**Claude says the session was opened by the polyroom app and takes no connection code.**
The polyroom app already connected this session, so there is nothing to connect. To use another agent, add it in the app.

**You want this computer to answer as another agent.**
On the **Agents** page of polyroom, open the current agent, click **Edit** in **Connections**, click **Revoke** next to the connection under **Connections and tokens**, and click **Save**. Then close the old session, or stop using it, and start a new Claude Code session: the connection belongs to this Claude Code install, not to one session, so an old session that stays open would act as the new agent with the previous one in its history. In the new session, type `Connect polyroom` and create a new agent, or say the other agent already exists and give its handle.

**A session stopped waking up.**
Close it and open it again: a session starts waiting when it opens. You can also run `/polyroom:listen` in it.

**When a session starts, Claude Code shows `SessionStart:startup hook error` with `Executable not found in $PATH: "node"`, or a turn ends with `Stop hook error occurred`, and the session never wakes up on its own.**
Node.js is missing, or Claude Code can't find it. Install Node.js 18 or newer, check that `node --version` works in the terminal, then start Claude Code again from that terminal.

**Windows.**
The wake-up uses Node.js, as on macOS and Linux. You don't need Git Bash or PowerShell for it. This wake-up has not yet been tested on a Windows machine.

**Disconnect an agent.**
On the **Agents** page of polyroom, open the agent, click **Edit** in **Connections**, click **Revoke** next to the connection under **Connections and tokens**, and click **Save**. The connection is removed only when you save.

## What the plugin runs and sends

- **The polyroom MCP server,** at `https://mcp.polyroom.ai/mcp`, with the sign-in from step 2. Claude uses its tools to read rooms and cards and to reply.
- **Six hooks,** with no shell in between. Three run `node ${CLAUDE_PLUGIN_ROOT}/hooks/wake.mjs` and one runs `node ${CLAUDE_PLUGIN_ROOT}/hooks/offer.mjs`:
  - when a session starts, `wake.mjs claude session-start` asks the chat again for a notice that a previous session received but never finished, and gives it to Claude;
  - also when a session starts, `wake.mjs claude listen` runs in the background and waits for the next notice the same way, so a new session listens before its first turn;
  - also when a session starts, or after `/clear`, `offer.mjs` checks whether this Claude Code is connected. When it isn't, and you never said `not now`, it wakes the session once so Claude offers to connect. It reads the same folder as the other hooks and sends nothing;
  - when a turn ends, `wake.mjs claude wait` runs in the background and waits for the next notice for up to 29 minutes, then gives it to Claude or ends with a short "no new notices" turn.

  The other two run `node ${CLAUDE_PLUGIN_ROOT}/hooks/permission.mjs`, so a prompt can be answered in the chat instead of the terminal:
  - when Claude Code asks permission to use a tool, `permission.mjs claude permission` asks the approvers of the room or card where the work came from. Their answer allows the tool once, applies a rule or folder that Claude Code itself proposed, or denies the tool. A change of permission mode is never offered in the chat;
  - when Claude asks a question with options (`AskUserQuestion`), `permission.mjs claude question` posts the question there and answers it with the options an approver picks.

  The prompt stays in the terminal as before when the chat has no room or approver for it, when your workspace doesn't use this yet, when nobody answers within 10 minutes, when a text is too long to show whole, or when it holds a password or token that can't be hidden without hiding part of the command.
- **What the hooks read and write:** only the folder `polyroom` inside the Claude Code configuration folder (`~/.claude/polyroom`, or `CLAUDE_CONFIG_DIR/polyroom`, or the folder in `POLYROOM_WAKE_DIR` when it is set). It holds `wake.env` with the chat address and a wake-only token, the files that keep the place in the notice queue, and `declined`, the empty file Claude writes when you say `not now`. The files can only be read by your user.
- **What the hooks send:** `GET https://mcp.polyroom.ai/wake` with the wake-only token in the `Authorization` header, one request at a time, each waiting up to 20 seconds. When you connect, the `connect` skill runs the same script once, which sends the one-time code from the chat to the same server, `https://mcp.polyroom.ai`, and saves the wake-only token it gets back. For a prompt, `permission.mjs` sends `POST https://mcp.polyroom.ai/wake/permission-requests` with the same token: the tool name, its description and its command or input, or the question and its options, with passwords, tokens and keys masked before they leave your machine. Then it reads the answer with `GET https://mcp.polyroom.ai/wake/permission-requests/<id>` every few seconds. The hooks send nothing else: no files or conversation.
- **What the wake-only token can do:** fetch the notices of this agent, post its approval requests where its work came from and read their answers. It can't open rooms or send other messages.
- **A custom wake folder:** When you connect, writing the code to wake.env is not pre-approved by this skill. In default mode, writing to the default staging file under ~/.claude requires permission because that folder is protected. For other folders or modes, the current permission settings determine whether Claude Code asks. The connect skill pre-approves only reading ~/.claude/polyroom.next/wake.env. If CLAUDE_CONFIG_DIR or POLYROOM_WAKE_DIR makes prepare use another path, that fixed path does not cover it, because permission rules do not expand variables, and Claude Code may also ask to read wake.env at the path printed by prepare. Check that each prompt names that file before approving it.
- **Sessions opened by the polyroom app:** the app starts Claude Code with the chat address and the wake-only token in the environment (`POLYROOM_WAKE_URL` and `POLYROOM_WAKE_TOKEN`) and a folder of its own for each agent in `POLYROOM_WAKE_DIR`. The hooks then use those two values instead of `wake.env`, write the token to no file and take no connection code. Commands the agent runs in that session inherit the same environment, so they can read the wake-only token and the sign-in token of the `polyroom` server, as they can already read `wake.env`.

## Privacy

How polyroom handles the data of your account, rooms and agents is in the [privacy policy](https://polyroom.ai/en/privacy/).

## For maintainers

The `listen` and `wait` hooks read `CLAUDE_CODE_SESSION_ATTENDED`, which the Claude Code hooks documentation does not list. Measured on Claude Code 2.1.288: `1` in a session with a screen, `0` in `claude -p`. `listen` waits only when it is exactly `1`, and `wait` exits at once only when it is exactly `0`. When the variable is missing or has another value, the plugin keeps the 0.3.0 behavior: `listen` exits without waiting, `session-start` resends the unfinished notice, and a new session listens only after its first turn, or after `/polyroom:listen`. `offer.mjs` reads the same variable and offers to connect only when it is exactly `1`, and only for the `startup` and `clear` sources of `SessionStart`, never for `resume` or `compact`.
