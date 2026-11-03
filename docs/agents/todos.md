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

**Nothing runs on a click.** Two ways in, both deliberate: a right-click
anywhere on the row, or its ⋯ button (which the keyboard can reach). A plain
click on the row does nothing at all — it used to start a pi session, one slip
away from the wrong project.

The menu (`components/todo-menu.ts` decides its entries) offers, per state:

| state | entries |
|---|---|
| not started | Run · Mark done · Edit · Move to project… · Delete |
| waiting for a person | Run · Mark done · Edit · Move to project… · Delete |
| running | Run (disabled) · Mark done · Edit · Move to project… · Delete |
| done | Reopen · Delete |

"A finished to-do is a record": it can be reopened (which makes it editable
again) or deleted, never edited or moved in place.

"Mark done" is offered in every state that is not done — a task finished outside
pi is as finished as one the agent closed, and a run that ends without saying so
leaves the row waiting for exactly that click. Marking a *running* one done ends
the to-do, not the session: the run keeps going, and the row's state follows the
to-do (`done`), not the live session.

Edit is its own dialog (`components/TodoEditDialog.tsx`), not a menu body: a note
can be long, and a form that closes on the next click outside loses what was
typed. It is the project trust dialog's shape — backdrop, `openStackedDialog()`
for Escape and focus, only the body scrolling, the note 40vh tall and resizable —
and **nothing but Save, Cancel and Escape dismisses it**: no backdrop click. A
blank title cannot be saved; an emptied note clears it (`note: null`). A write
that fails keeps the dialog open with its text.

Move swaps the menu's body for the sidebar's project list, the current one
checked, and saves the chosen `project` through the same `update`. It keeps the
menu open (`event.keepOpen()`), which is what made "Move to project…" do nothing
at first: the menu closed on select before the swapped body could be seen. A
waiting row keeps its inline "Done" button.

