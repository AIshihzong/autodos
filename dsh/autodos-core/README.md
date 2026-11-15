# dsh-autodos-core

Autodos as a DeepSeek Harness (DSH) plugin, step 1: the event ledger, the eight objects, the status board and a one-time import of the old Autodos board.

## What it does

- **Ledger** (`lib/store.js`): an append-only `events` table in SQLite (`node:sqlite`). The current state of each object (`objects` table) is folded from its `<kind>.created|updated|removed` events and can be rebuilt from the events alone. Every event records who did it, why, what changed and what it was before, and links to a task for that task's timeline.
- **Objects**: goal, project, task, staff, machine, thread, output, decision (plus requirement, rule and settings carried over from Autodos).
- **Import** (`lib/import.js`): on first open, reads `~/.autodos/db.json`, or `~/.crewboard/db.json` from before the rename (read-only, never written), and imports projects, agents, workers, requirements, todos with their messages, PRs and evidence, chief-of-staff chat and rules. Runs once per ledger.
- **Not imported yet**: topics and run history. They come with step 3, when the runner moves in.
- **Status board** (`lib/board.js`): open tasks (failed ones included, since they wait for a reply or retry) sorted by what waits on you first, each with who (staff and machine), state, what it waits for or where it is stuck, last progress and outputs.
- **Running tasks** (`lib/actions.js`, `lib/paseo.js`): a task is dispatched through Paseo, which starts Claude Code (or Codex) in its own worktree on branch `autodos/<number>`. A background sync (every 5 s) puts the agent's output in the timeline. A permission request becomes an open decision that only the person answers, from the panel. A finished turn asks you to accept the result or say what to change.
- **Landing** (`lib/land.js`): accepting runs the project's `check` command (if set) in the task worktree; a failure goes back to the agent. Then the branch is merged (`--no-ff`) into its base. The merge never touches a checkout with uncommitted changes, and a conflict goes back to the agent to resolve; neither is forced. Nothing is pushed.
- **Budget**: each task may spend `budgetUsd` (task, else project, else the plugin config, else the imported Autodos setting, else $5). At the limit the agent is stopped and you choose: add budget and continue on the same branch, or close the task.
- **DSH entry** (`index.js`): tools for the chief of staff (`autodos_board`, `autodos_task`, `autodos_projects`, `autodos_team`, `autodos_create_project`, `autodos_update_project`, `autodos_create_task`, `autodos_reply`, `autodos_retry`; none of them can answer a permission request), and HTTP routes `GET /api/autodos/board`, `GET /api/autodos/task?id=`, `GET /api/autodos/projects`, `GET /api/autodos/team` and `POST /api/autodos/action` for the panel.
- **Team** (`lib/team.js`): staff (a name, what they are responsible for, the agent they run: Claude Code, Codex or auto, the machine they work on, and standing instructions added to every dispatch) and machines (this one, plus others reached through their Paseo daemon `host:port`). On start the plugin notes which agents this machine has, by whether the command is on PATH or its folder exists; no conversation is read. A task runs on its chosen machine, else its staff member's machine, else this one.
- **Panel** (`lib/client.js`): an "Autodos" item in the DSH sidebar. The page has the Autodos brand at the top and three sections: 任务 (inbox, board, list, and a task drawer with threads, outputs, decisions and timeline), 员工 (add, edit, remove staff) and 机器 (add, edit, remove machines; see what runs where and which agents are installed).

## Try the import without DSH

```sh
node bin/import.js                       # reads ~/.autodos/db.json, writes a new ledger in /tmp
node bin/import.js --from path/to/db.json --out /tmp/test-ledger.db
```

It prints the import counts and the board as text.

## Install in DSH

Needs DSH ≥ 0.2.2-rc.1 (Node ≥ 24.9) and pnpm.

```sh
dsh plugin --profile web add ./dsh/autodos-core
dsh --profile web
```

The plugin has to be installed first: `dsh --patch` alone fails with `Cannot find package 'dsh-autodos-core'`.

The HTTP routes sit behind the DSH login, so `curl` without the session cookie gets 401.

Config (all optional):

| key | default | meaning |
| --- | --- | --- |
| `dataDir` | `$AUTODOS_DSH_HOME`, else `<DSH_HOME or ~/.dsh>/plugins/autodos` | where `autodos.db` lives |
| `autodosData` | `$AUTODOS_DATA`/`db.json`, else `~/.autodos/db.json`, else `~/.crewboard/db.json` | the old board to import |
| `importAutodos` | `true` | set `false` to start empty |
| `paseo` | `{}` | `{bin, host}` for the Paseo CLI, or `false` for read only |
| `provider` | `claude` | the agent new tasks use |
| `budgetUsd` / `budgetStepUsd` | imported setting, else 5 | default budget per task / how much "add budget" adds |
| `syncMs` | `5000` | how often running agents are checked |

## Tests

```sh
npm test
```
