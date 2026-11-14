# dsh-autodos-core

Autodos as a DeepSeek Harness (DSH) plugin, step 1: the event ledger, the eight objects, the status board and a one-time import of the old Autodos board.

## What it does

- **Ledger** (`lib/store.js`): an append-only `events` table in SQLite (`node:sqlite`). The current state of each object (`objects` table) is folded from its `<kind>.created|updated|removed` events and can be rebuilt from the events alone. Every event records who did it, why, what changed and what it was before, and links to a task for that task's timeline.
- **Objects**: goal, project, task, staff, machine, thread, output, decision (plus requirement, rule and settings carried over from Autodos).
- **Import** (`lib/import.js`): on first open, reads `~/.autodos/db.json`, or `~/.crewboard/db.json` from before the rename (read-only, never written), and imports projects, agents, workers, requirements, todos with their messages, PRs and evidence, chief-of-staff chat and rules. Runs once per ledger.
- **Not imported yet**: topics and run history. They come with step 3, when the runner moves in.
- **Status board** (`lib/board.js`): open tasks (failed ones included, since they wait for a reply or retry) sorted by what waits on you first, each with who (staff and machine), state, what it waits for or where it is stuck, last progress and outputs.
- **DSH entry** (`index.js`): tools `autodos_board` and `autodos_task` for the lead agent, and HTTP routes `GET /api/autodos/board` and `GET /api/autodos/task?id=`.
- **Panel** (`lib/client.js`): a "任务 / Tasks" item in the DSH sidebar with the board and a task detail view (threads, outputs, decisions, timeline).

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

## Tests

```sh
npm test
```
