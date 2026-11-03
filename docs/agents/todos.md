# The to-do list

A human's list of things to do, one project each, runnable with one click. Pi Web
owns it: the data is `~/.pi/agent/pi-web-todos.json`, written by the server, read
by the right panel. The pi CLI does not see it (and would have no use for it).

This area is a deliberate departure from `CONTRIBUTING.md`'s out-of-scope list —
it is a Pi Web-only config file (line 18) for something that could have been a pi
extension (line 17), added as its own small subsystem (line 20). Upstream would
decline it; it lives in this fork, and the design is recorded in
`docs/superpowers/specs/2026-11-02-task-list-design.md`.

## Data

`pi-web-todos.json`: `{ version: 1, revision, todos: [...] }`, one entry per
to-do — `id` (8 hex), `title`, optional `note`, `project` (absolute cwd, the
session's start directory too), optional `sessionId` (the latest run),
`createdAt`, `updatedAt`, and for a finished one `doneAt` and `doneBy`
(`"user"` or `"agent"`).

**Only two states are stored** (`open`, `done`). The panel's four are derived
(`todoDisplayStatus()`): no `sessionId` → not started; a `sessionId` in
`/api/agent/running` → running; a `sessionId` that is not running (or whose
session is gone) → waiting for a person; `done` → done. Nothing writes a derived
state back, so a poll that lands between two writes cannot leave a wrong row.

Writes go through `lib/todos.ts`, which copies `lib/session-ui-state.ts`: a
per-path write queue on `globalThis`, a `proper-lockfile` lock, an atomic replace
(`writePrivateFileAtomicSync`), a revision bumped only when something changed
(`applyTodoRequest()` returns the state itself when nothing did), a stat-keyed
read cache so a poll costs one stat, and a file that cannot be parsed — or is
too large, or is not a regular file — moved aside to
`pi-web-todos.json.corrupt-<ms>` instead of being overwritten. Unknown top-level
fields of a file written by a newer build are carried through a write.

`MAX_TODOS_FILE_BYTES` (`lib/todos-shared.ts`) is derived from the caps, not
picked: a file past it is not one this build wrote.

## API

`app/api/todos/route.ts`:

- `GET` → `{ todos, revision }`, `no-store`.
- `POST` one action: `add` (`title`, optional `note`, `project`), `update`
  (`title` / `note` / `project`; `note: null` clears it), `complete`, `reopen`,
  `delete`, `start`. Answers the list after the change (plus `sessionId` for
  `start`). Refusals carry a `reason`: `invalid-request` (400), `content-type`
  (415), `request-denied` (403), `not-found` (404), `locked` (409, another
  process holds the file), `cwd-missing` (400, with the folder), `write-failed`
  (500).
- `attach` is never parsed from a request body: only the server's own `start`
  sets a `sessionId`.

## Starting a to-do

`lib/todos-start.ts`. One click (`POST { action: "start", id }`) does what
`/api/agent/new` does — `startRpcSession()` with a one-time key, then
`allowFileRoot()` and `invalidateSessionListCache()` — in the to-do's project,
sends `todoStartPrompt()` as the first message, and records the session id on the
to-do.

Three rules keep a double click from running a task twice:

- **Serialized per to-do** (`serializeByKey` on a process-wide queue), so two
  concurrent requests cannot both see "no session yet".
- **Running, not open**, is the reuse test: `isRpcSessionRunning()` — the same
  predicate `/api/agent/running` reports. An open but idle wrapper is a session
  waiting for a person, and clicking a waiting to-do starts a new run.
- **A failed record does not fail the run**: if the write is refused after the
  session is already working, the answer is still the session id (the panel's
  retry would otherwise start a second session); the write error is logged.

## The completion signal

`lib/builtin-todo-extension.ts` registers `todo_complete`, which takes no
arguments and marks that to-do done with `doneBy: "agent"`. It is built per
session and added by `createPiWebBuiltinExtensions({ todoId })`, whose only
caller is `lib/rpc-manager.ts` for a session started with `todoId` — so the tool
exists only in the session the to-do started, and the user's tool preset is never
pinned to make room for it. It is not a `builtin()` extension: `BUILTIN_EXTENSION_NAMES`
is the CLI's own `-builtin:` list.

A run that never calls it leaves the row waiting for a person (the panel's
"Done" button, `doneBy: "user"`). That is the point of the design: a finished
turn is not a finished task.

## The panel

`components/TodoPanel.tsx`, opened from the session sidebar's footer row
("Todos · N", `lib/session-tree.ts`'s `footer-todos`) into the right panel as a
`kind: "todo"` tab (`components/TabBar.tsx`, wired in `components/AppShell.tsx`).
Rows group by project (`groupTodos()`, named by the project's display name when
one exists), unfinished first, done at the bottom.

**Nothing runs on a click.** A row opens a menu — right-click at the pointer, or
a click/Enter/Space for touch and keyboard — and the menu's "Run" starts it: a
plain click was one slip away from starting a pi session in the wrong project.
The menu (`components/todo-menu.ts` decides its entries) offers, per state: Run
(disabled while that run is live), "Mark done" for a waiting run, "Move to
project…" (the sidebar's projects, the current one checked, applied as an
`update` with the new `project`), Reopen for a finished one, and Delete alone at
the end. A waiting row also keeps its inline "Done" button.

`hooks/useTodos.ts` holds the data: one action at a time, the server's answer is
the truth (no optimistic merge — the list is small and every answer carries the
revision the next poll agrees with).

## Tests

`lib/todos-shared.test.mjs` (the pure rules), `lib/todos.test.mjs` (the store on
a real temp dir, one per test), `app/api/todos/route.test.mjs`,
`app/api/todos/start.test.mjs` (the injected caller), `lib/builtin-todo-extension.test.mjs`,
`components/TodoPanel.test.mjs`, and `components/AppShell.todos.test.mjs` (the
wiring, read from source).
