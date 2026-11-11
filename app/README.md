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

Done on a todo with a branch puts it in its project's merge queue (phase *Merging*). One at a time, Autodos merges the latest base branch into the todo branch in its worktree, re-runs the project checks on the combined code, and only then merges it into the base. A conflict goes back to the author agent with instructions to merge and resolve it (Settings: on by default), then returns to Review; failing checks go straight back to Review (in an unattended project, back to the author agent). Say "ship it" to queue everything in Review.

## Other machines

Settings → Machines → *Add machine* gives a key. On the other computer, in a copy of this app, run:

```bash
npm run worker -- --hub http://localhost:4747 --key cbk_…
```

The worker connects out to the hub (no open port), long-polls for work, and for each turn checks out the todo branch from the project's git remote `origin`, runs Claude Code or Codex there, commits and pushes the branch back; the hub pulls it into the todo's worktree, so checks, review and merge stay on the hub. Pick the machine per agent (Agents → Machine). Each machine has its own parallel limit. Reach the hub through an SSH tunnel (`ssh -L 4747:localhost:4747 hub-mac`) or a public https tunnel; `/workers/*` only answers to a machine key.

## Weekly retro

Usage → Weekly retro shows the last 7 days: done and created todos, rework rate, checks green on the first try, review findings, merge conflicts, median time to done, the most reworked todos and recurring problems. *Ask the lead to write it up* (or say "retro" / "周回顾") posts a summary with suggestions in the conversation.

## Pull requests, previews, sub-tasks

- **Pull requests** (Projects → *project* → Settings → When done: *Open a pull request*): Done pushes the todo branch and opens a PR with your logged-in `gh`. Every minute Autodos reads the PR: failing CI checks (with the end of the failing job's log; a cancelled run is not a failure), reviews and comments go back to the same todo as outside events (data, never instructions), the agent fixes them, and the branch is pushed again. The PR targets the project's base branch; a title template (`prTitle` in `autodos.json`, e.g. `[{ref}] {title}`) is optional. Merged on GitHub → Done; closed → Closed.
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

Add a folder under **Projects**. If it is a git repository, each todo gets its own branch and worktree, each finished turn is committed there, Review shows the diff stat, and **Done** merges it into the project's base (or **Done without merging** leaves it on the branch). Plain folders are edited in place.

Per project (Projects → the project → Settings):

- **Base branch**: where work starts from and lands. Blank means whatever the project folder has checked out. A base nobody has checked out is moved directly (compare-and-swap on the ref), so the project folder can stay on another branch, or detached, and is never touched.
- **Branch names**: a template such as `crew/{ref}-{slug}`. `{number}` is the todo number, `{slug}` comes from the title, `{ref}` is the todo's reference (`AP-041` at the start of a title is picked up by itself). Default `autodos/todo-{number}`.
- **Setup command**: runs once in each new worktree, on the hub and on worker machines (`pnpm install --frozen-lockfile`, copying an env file…). If it fails, the todo fails and says why.
- **Push the base branch to origin after each merge**: for a base that other machines or GitHub should see. Never forced; if origin has commits this machine lacks, they are merged in first.

## Unattended projects

A project can keep itself moving while you are away. Everything below is off until you turn it on for that project.

- **Accept changes by itself**: a change whose checks passed and whose AI review left no open finding merges without waiting at Review. It still waits for you when the project has no checks, the checks fail, the review did not run or could not read the whole diff, the change is larger than the limit you set, or it touches a **protected path** (`deploy/*`, `.github/workflows/*`, `*.env`, one pattern per line; `autodos.json` is always protected). Each of those leaves a line saying why. If checks fail later, on top of the latest base, the change goes back to its author agent instead of to you; after three rounds it waits for you.
- **Backlog file**: a Markdown checklist in the repository, read from the base branch. Each unchecked `- [ ] item` becomes a todo (indented lines under it are its description), a few at a time, each item only once; the agent ticks the item in the same change. Agents add follow-up work to the file instead of widening their change, so the file is the queue.
- **Upstream repository**: for a fork. On a timer Autodos fetches the upstream branch and merges it into the base in a scratch worktree, runs the setup command and the checks there, and lands it only when clean and green. A conflict or a red result becomes a todo for an agent. The upstream remote's push address is disabled; nothing is ever pushed to it.
- **Rules** take an *open todos at most* limit, so a nightly rule waits while its previous run is still unfinished.

These settings can live in the repository as `autodos.json`, so a fresh machine needs one click (**Load autodos.json**) or `POST /api/projects/<id>/load-config`:

```json
{
  "baseBranch": "crew/main",
  "branchTemplate": "crew/{ref}-{slug}",
  "setup": "npm ci",
  "checks": ["npm run typecheck", "npm test"],
  "pushBase": true,
  "autopilot": { "accept": true, "maxFiles": 40 },
  "protectedPaths": ["deploy/*", ".github/workflows/*", "*.env"],
  "backlog": { "file": "docs/BACKLOG.md", "maxOpen": 2 },
  "upstream": { "url": "https://github.com/owner/repo", "branch": "main", "every": 60, "mirror": true },
  "lead": { "decide": true, "ownerPaths": ["deploy/*", "*.env", "database/migrations/*"] },
  "analyst": true,
  "knowledge": ["docs/PROJECT_BRIEF.md", "docs/requirements/"],
  "memory": { "decisions": ["Never deploy from here"], "declined": [] },
  "rules": [{ "name": "Nightly sweep", "cron": "0 3 * * *", "title": "Nightly sweep", "prompt": "Find one flaky test and fix it.", "maxOpen": 1 }]
}
```

The file is applied only when you load it. When it changes on the base branch the project shows that it is out of date, and nothing changes until you load it again: the file decides what runs on your machine and what may land without you, so an agent's edit to it must not take effect by itself.

For an unattended project, set the agents' permission mode so they can run commands (Settings), give it a budget per todo, and leave the project folder alone: use a base branch that is not checked out there.

## A team that decides for itself

By default every question an agent asks, every plan and every finished change comes to you. A project can instead be run the way a customer works with a professional team: you bring ideas and problems, and the team settles what is technical among themselves. Two roles do that, both off until you turn them on for the project (Projects → Settings → Team, or `autodos.json`).

- **The lead decides technical questions** (`lead.decide`). The lead stands at each gate before you do: an agent's question, a plan waiting to be confirmed, a change that did not land by itself, a failed run. It reads the task, the diff, the checks and the review, and then answers the agent, confirms the plan, accepts the change, sends it back with what to fix, or asks for another try. Environments, repositories, branches, tooling, which approach to take, whether a review finding is real: those never reach you. It passes on only what is yours: what the product does where the request does not settle it, money, anything that cannot be undone outside the repository, narrowing what you asked for, access only you can give. Then you get one question in plain words with the lead's suggestion.
  - What the lead may accept is limited by facts, not by its opinion: it cannot accept a change whose checks fail, that has an open high-severity review finding, that the reviewer could not read whole, or that touches a file on the **Only you approve** list (`lead.ownerPaths`; `autodos.json` is always on it). Protected paths never land by the autopilot alone: with a lead they go to the lead, without one to you.
  - After six rounds on one todo the lead stops and the todo waits for you. A todo you moved by hand, or that the lead passed to you, stays yours until it runs again. Acting on a todo yourself always wins over a decision the lead is still making.
  - When the lead's own runtime cannot answer (a usage limit, the CLI failing) it looks again after 1, 5 and 15 minutes before telling you, and says that it could not look rather than asking you the engineer's question. Reading `autodos.json` again, or `POST /api/todos/<n>/action {"action":"lead"}`, hands such a todo back to the lead.
  - Every decision is a line on the todo and in the project's log (Projects → Settings → Team), and a standing technical decision goes into project memory so nobody asks again.
- **Requirements analyst** (`analyst`). The conversation with the lead becomes a conversation about what you want: it reads the project's knowledge files and the repository, says back what it understood, relates it to requirements that already exist, asks at most two questions that only you can answer (each with the answer it would assume), and files todos once it is clear enough to build, each with scope and at most three acceptance checks a person can see happen. It never asks you about code, environments or tooling.
- **Project knowledge** (`knowledge`): files and folders in the repository that the lead and the analyst read first, for example a project brief, the requirement list and decision notes. Keep them in the repository so they are reviewed like code; a rule can have an agent refresh the brief every week.

The lead and the analyst run on the runtime chosen for the lead (Settings), read-only.

Three things you are never asked, whether or not a project has a lead:

- **Which project.** A message sent without a project picked (from the conversation with all projects shown, or from Feishu) goes to the project it names; else to the one the conversation is already about; else to the only project that has its own team; else to the one worked on most recently. With several projects the reply says where it went.
- **"Was that an answer?"** When a todo is waiting on a question and you simply reply in the conversation, your words go to that todo and it carries on; no new todo is made. Start with `#12` to answer a particular one. A long message, or one that starts with "new request", is a request of its own.
- **Starting over somewhere else.** Changing a todo's project (the drawer, or the lead's decision "move" when an engineer asks which repository to work in) starts it over in the right project. What it wrote in the old place is left as it is: a worktree that holds work keeps its branch.

## Agents and runtimes

Each agent has a name, a role (used by the Lead to assign work), a runtime (`Claude Code`, `Codex`, `Demo`, or the default) and an optional model. Claude Code runs with `--permission-mode acceptEdits` by default; switch to `bypassPermissions` in Settings if agents need to run commands unattended. Codex runs in its `workspace-write` sandbox by default (no network, `.git` read-only); *Codex sandbox* in Settings can open the network or remove the sandbox, which a project needs when its agents install dependencies or finish a `git merge` themselves. A Claude session is resumed on every revision, so replies keep their context.

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
server/   Node HTTP API, SSE events, todo lifecycle (runner.js), Lead (chief.js), runtimes, git worktrees, unattended projects (autopilot.js)
web/      React + Vite UI (board, Lead chat, todo drawer, ⌘K palette, agents, projects, schedules, usage, settings; EN/中文; light/dark)
src-tauri/  Tauri shell: starts or reuses the server, folder picker, notifications, dock badge, outside links
mcp/      stdio MCP server
```
