# Autodos

A task board where you and your AI coding agents work together. Tell the **Lead** what you want; it splits the work into todos, assigns them to agents by role, runs them in parallel (each in its own git worktree), and stops at the two points where you decide: **Confirm** (approve a plan) and **Review** (accept and merge the change).

Runs as a local web app or as a desktop app (Tauri, about 2 MB to download). The desktop app uses the Node.js 20+ already on your machine to run its server. Agents run through the coding CLIs already on your machine: **Claude Code** (`claude`) and **Codex** (`codex`). Without either, a built-in **Demo** runtime simulates the work so you can try everything.

## Run it

```bash
npm install
npm run build && npm start        # web app at http://localhost:4747
npm run desktop                   # desktop app (reuses a running server, or starts its own)
npm run dev                       # development: API on :4747 + Vite on :5173 with hot reload
npm test                          # end-to-end server tests (demo runtime, real git)
npm run dist:mac                  # package Autodos.app and a .dmg with Tauri (needs Rust)
npm run check:desktop             # open the desktop app, check the board loaded, quit
```

Data lives in `~/.autodos/` (`db.json`, per-todo `worktrees/`, `scratch/` for todos without a project). Set `AUTODOS_DATA` to use another folder, `PORT` to change the web port.

## How a todo moves

| Phase | Column | What happens |
|---|---|---|
| To do | Backlog | Filed, not started |
| Queued | In progress | Waiting for a free slot (Settings → Parallel todos) |
| Planning | In progress | Agent reads the code and writes a plan (Plan first only, read-only) |
| Confirm | Needs you | Approve the plan, or reply to get a revised one |
| Building | In progress | Agent makes the change; output streams live |
| Review | Needs you | Accept with **Done** (merges the branch) or reply to request changes |
| Failed | Needs you | Retry, or reply with guidance |
| Done / Closed | Done | Finished or set aside; **Reopen** reruns it |

Drag cards between columns to start, stop or finish them. Say "ship it" / "合并吧" to the Lead to accept everything in Review.

## Quality gates

Between an agent's build turn and your Review, every change goes through:

1. **Checks** — the commands listed under Projects → *project* → Checks (Detect suggests them from `package.json`, `Cargo.toml`, `go.mod`, pytest config). If any fail, the author gets the output and a fix round, up to *Automatic fix rounds* (Settings), and may not weaken tests to pass. Results and output are shown on the todo.
2. **AI review** — a second agent reads the diff read-only and returns findings with severity. With the reviewer on *Use default*, Autodos picks a different runtime than the author (Claude Code ↔ Codex). Obvious, safe fixes go back to the author automatically, then checks run again; the rest are listed for you.
3. **Budget** — each run has a time and dollar limit (Settings → Budget per run). Past either, the todo stops in Failed and says why; Retry or a reply starts a fresh budget.

**Project memory** (Projects → *project* → Memory): decisions you made and things you declined. Agents and the Lead read it before every turn. Any message you wrote in a todo can be saved there with one click.

## Rules, events and notifications

**Rules** (left bar → Rules) start work by themselves: on an interval, on a cron schedule (`0 9 * * 1-5`), or when an event arrives. Each rule names the agent, the project, the instructions and whether to notify you. Pause, resume and *Run now* are on each rule. Telling the lead "every day …" creates one.

**Event sources**:
- *Webhook (any system)*: `POST /hooks/<id>` with `Authorization: Bearer <key>` and JSON `{ "type": "alert.fired", "title": "…", "body": "…", "key": "same-object-id", "id": "delivery-id" }`. Only a hash of the key is stored.
- *GitHub webhook*: point a repository webhook at `/hooks/<id>` with the shown secret; signatures are checked.
- *GitHub issues (poll)*: uses your logged-in `gh`, no public address needed; issues opened after the source was added become events.

Webhooks need a public address (a tunnel such as `cloudflared` to this Mac). `/hooks/*` is the only part of the server reachable through one, and it requires the key or signature. Event text is always passed to agents as data, never as instructions; a later event for the same object is added to its open todo as an outside event and can never answer a question for you.

**Question cards**: when a choice is genuinely yours, an agent stops with a question and options (phase *Question*, column *Needs you*); click an option or write your own answer and it continues.

**Notification channels** (Settings): Feishu/Lark and DingTalk bots (with optional signing secret), WeCom, Slack or any JSON webhook. Only public https addresses are allowed, redirects are not followed, and webhook URLs are never sent back to the browser.

## Merge queue

Done on a todo with a branch puts it in its project's merge queue (phase *Merging*). One at a time, Autodos merges the latest base branch into the todo branch in its worktree, re-runs the project checks on the combined code, and only then merges it into the base. A conflict goes back to the author agent with instructions to merge and resolve it (Settings: on by default), then returns to Review; failing checks go straight back to Review. Say "ship it" to queue everything in Review.

## Other machines

Settings → Machines → *Add machine* gives a key. On the other computer, in a copy of this app, run:

```bash
npm run worker -- --hub http://localhost:4747 --key cbk_…
```

The worker connects out to the hub (no open port), long-polls for work, and for each turn checks out the todo branch from the project's git remote `origin`, runs Claude Code or Codex there, commits and pushes the branch back; the hub pulls it into the todo's worktree, so checks, review and merge stay on the hub. Pick the machine per agent (Agents → Machine). Each machine has its own parallel limit. Reach the hub through an SSH tunnel (`ssh -L 4747:localhost:4747 hub-mac`) or a public https tunnel; `/workers/*` only answers to a machine key.

## Weekly retro

Usage → Weekly retro shows the last 7 days: done and created todos, rework rate, checks green on the first try, review findings, merge conflicts, median time to done, the most reworked todos and recurring problems. *Ask the lead to write it up* (or say "retro" / "周回顾") posts a summary with suggestions in the conversation.

## Pull requests, previews, sub-tasks

- **Pull requests** (Projects → *project* → Settings → When done: *Open a pull request*): Done pushes the todo branch and opens a PR with your logged-in `gh`. Every minute Autodos reads the PR: failing CI checks, reviews and comments go back to the same todo as outside events (data, never instructions), the agent fixes them, and the branch is pushed again. Merged on GitHub → Done; closed → Closed.
- **Preview** (same Settings, *Preview*, e.g. `npm run dev -- --port {port}`; *Detect* suggests one): the todo's drawer gets a Preview button that starts the dev server in the todo's own worktree on a free port and opens it. At most three run at once; they stop when the todo lands or closes.
- **Sub-tasks**: an agent that calls the MCP tool `create_todo` while working on a todo creates a sub-task under it (Autodos passes the todo number to the agent's MCP server). Sub-tasks are limited in depth and number (Settings) and spend from the parent's budget, so delegation can't fan out without bound.

## Reviewing and steering

- **Line comments**: in a todo's Changes tab, click **+** beside any line, write a comment, collect as many as you like, then **Send to agent**: they go back as one message with file and line, and the agent revises.
- **Steering**: write to an agent while it works and it changes course at once: the running turn stops and a new one starts with your message, in the same Claude session.
- **Evidence**: agents save proof of their checks (screenshots, test output, API responses) in `.autodos/evidence/` (kept out of git); Autodos keeps a copy and shows it in the Evidence tab. Files are served as images or plain text only, in a sandbox.
- **Addresses**: every page and todo has a URL (`#/inbox`, `#/todo/12`), so Back works and links from notifications open the todo.

## Pairing machines

Settings → Machines → **Pair a machine** gives a one-time code (10 minutes). On the other computer run `node worker/worker.js --hub <hub> --pair <code>`: both screens show the same four words; approve in Autodos and the worker saves its key. Afterwards `node worker/worker.js` is enough. **Add over SSH** (`user@host`, using your own ssh keys) copies the worker there and keeps one ssh session open that runs it through a reverse tunnel, so no public address or open port is needed.

## Projects and git

Add a folder under **Projects**. If it is a git repository, each todo gets branch `autodos/todo-N` in its own worktree, each finished turn is committed there, Review shows the diff stat, and **Done** merges it into the branch your main checkout is on (or **Done without merging** leaves it on the branch). Plain folders are edited in place.

## Agents and runtimes

Each agent has a name, a role (used by the Lead to assign work), a runtime (`Claude Code`, `Codex`, `Demo`, or the default) and an optional model. Claude Code runs with `--permission-mode acceptEdits` by default; switch to `bypassPermissions` in Settings if agents need to run commands unattended. A Claude session is resumed on every revision, so replies keep their context.

## MCP

Let any agent read and update the board:

```bash
claude mcp add autodos -- node /absolute/path/to/app/mcp/server.js
```

Tools: `list_todos`, `get_todo`, `create_todo`, `comment_todo`, `move_todo`, `ask_lead`. Set `AUTODOS_URL` if the server is not on `http://127.0.0.1:4747`.

## Security

The server binds to `127.0.0.1` only, and refuses write requests that come from another web origin or are not JSON, so a web page you visit cannot start agents on your machine.

## Layout

```
server/   Node HTTP API, SSE events, todo lifecycle (runner.js), Lead (chief.js), runtimes, git worktrees
web/      React + Vite UI (board, Lead chat, todo drawer, ⌘K palette, agents, projects, schedules, usage, settings; EN/中文; light/dark)
src-tauri/  Tauri shell: starts or reuses the server, folder picker, notifications, dock badge, outside links
mcp/      stdio MCP server
```
