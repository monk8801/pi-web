// The human to-do list's types and pure rules. The panel, the store and the
// session-start route all import this module, so it holds only what both
// boundaries can run: the server keeps the state in `pi-web-todos.json`
// (`lib/todos.ts`), and the client applies the same requests optimistically.
// Client-safe: no Node imports.

export const TODOS_VERSION = 1;
export const MAX_TODOS = 2000;
export const MAX_TODO_TITLE_LENGTH = 200;
export const MAX_TODO_NOTE_LENGTH = 4000;
export const MAX_PROJECT_LENGTH = 4096;
/** Most characters a session id may have; a real one is a UUID. */
const MAX_SESSION_ID_LENGTH = 200;
/** Eight hex characters, the style of `session-ui-state.json`'s keys. */
const TODO_ID_PATTERN = /^[0-9a-f]{8}$/;
/**
 * Mirrors `SESSION_ID_PATTERN` of `lib/session-ui-state-shared.ts`: the ids pi
 * writes (UUIDs). Declared here rather than imported, so this module stays a
 * leaf the client can load on its own.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Only two states are stored; "running" and "awaiting confirmation" are derived from the session. */
export type TodoStatus = "open" | "done";
export type TodoDoneBy = "agent" | "user";
/** Display state: not started / running / awaiting confirmation / done. */
export type TodoDisplayStatus = "open" | "running" | "confirm" | "done";

export interface Todo {
  id: string;
  title: string;
  /** Multi-line description, optional. */
  note?: string;
  /** Absolute path: the todo's project, and the cwd of the session it starts. */
  project: string;
  /** The pi session of the latest run. */
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
  doneBy?: TodoDoneBy;
  status: TodoStatus;
}

export interface TodosState {
  version: typeof TODOS_VERSION;
  /** Monotonic; the server adds one on every write that really changed the file. */
  revision: number;
  todos: Todo[];
}

export interface TodoAddRequest { action: "add"; title: string; note?: string; project: string }
/** `note`: a string sets it, null removes it, absent leaves it. */
export interface TodoUpdateRequest { action: "update"; id: string; title?: string; note?: string | null; project?: string }
export interface TodoIdRequest { action: "complete" | "reopen" | "delete"; id: string }
/**
 * The server fills in the session id after `start`; no client sends it, so
 * `parseTodoRequest` never produces one (`lib/todos-start.ts` builds it).
 */
export interface TodoAttachRequest { action: "attach"; id: string; sessionId: string }
export type TodoRequest =
  | TodoAddRequest
  | TodoUpdateRequest
  | TodoIdRequest
  | TodoAttachRequest;

export type TodoRequestParse =
  | { ok: true; request: TodoRequest }
  | { ok: false; error: string };

export function emptyTodosState(): TodosState {
  return { version: TODOS_VERSION, revision: 0, todos: [] };
}

/** `value` trimmed and cut at `max`; undefined when it is no text (not a string, or nothing but spaces). */
function capped(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text.slice(0, max) : undefined;
}

/**
 * A title as it is stored: trimmed, at most MAX_TODO_TITLE_LENGTH characters.
 * Undefined when it is no title. Every path that writes a title goes through
 * this, so a typed caller cannot store what the next read would cut short.
 */
function todoTitle(value: unknown): string | undefined {
  return capped(value, MAX_TODO_TITLE_LENGTH);
}

/** A note as it is stored; undefined for none (not a string, or nothing but spaces). */
function todoNote(value: unknown): string | undefined {
  return capped(value, MAX_TODO_NOTE_LENGTH);
}

/** A project as it is stored; undefined for none. */
function todoProject(value: unknown): string | undefined {
  return capped(value, MAX_PROJECT_LENGTH);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && TODO_ID_PATTERN.test(value);
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SESSION_ID_LENGTH && SESSION_ID_PATTERN.test(value);
}

/** Epoch ms as the file carries them: a whole, non-negative number JSON keeps as it is. */
function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** One entry as the file may carry it; null when it is not a todo this module can work with. */
function validTodo(raw: unknown): Todo | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const id = entry.id;
  const title = todoTitle(entry.title);
  const project = todoProject(entry.project);
  const status = entry.status === "done" ? "done" : entry.status === "open" ? "open" : null;
  if (!validId(id) || title === undefined || project === undefined || status === null) return null;
  const createdAt = timestamp(entry.createdAt) ?? 0;
  const updatedAt = timestamp(entry.updatedAt) ?? createdAt;
  const note = todoNote(entry.note);
  const sessionId = entry.sessionId;
  // The completion's time and author are kept only while the todo is done:
  // a reopen drops both, so a stale pair cannot outlive its state.
  const doneAt = timestamp(entry.doneAt);
  const doneBy = entry.doneBy === "agent" ? "agent" : entry.doneBy === "user" ? "user" : undefined;
  return {
    id,
    title,
    ...(note ? { note } : {}),
    project,
    ...(validSessionId(sessionId) ? { sessionId } : {}),
    createdAt,
    updatedAt,
    ...(status === "done" && doneAt !== undefined ? { doneAt } : {}),
    ...(status === "done" && doneBy ? { doneBy } : {}),
    status,
  };
}

/** Reading the file: a broken entry is dropped rather than trusted; null when the document itself is unusable (the caller reads that as an empty list). */
export function normalizeTodosState(raw: unknown): TodosState | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const document = raw as Record<string, unknown>;
  // Another version may mean other rules; it is not read as this one.
  if (document.version !== undefined && document.version !== TODOS_VERSION) return null;
  const revision = typeof document.revision === "number" && Number.isSafeInteger(document.revision) && document.revision >= 0
    ? document.revision
    : 0;
  const list = Array.isArray(document.todos) ? document.todos : [];
  const todos: Todo[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    // The cap comes first: what is past it is not validated at all.
    if (todos.length >= MAX_TODOS) break;
    const todo = validTodo(entry);
    // A hand-edited file may repeat an id; the first entry wins, so two todos
    // never answer to one id.
    if (!todo || seen.has(todo.id)) continue;
    seen.add(todo.id);
    todos.push(todo);
  }
  return { version: TODOS_VERSION, revision, todos };
}

function parseId(value: unknown): { ok: true; id: string } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: false, error: "id is required" };
  if (!validId(value)) return { ok: false, error: "id must be eight hex characters" };
  return { ok: true, id: value };
}

/** A request's note: null removes it, a string sets it, anything with no text removes it too, as `applyTodoRequest` reads it. */
function parseNote(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return todoNote(value) ?? null;
}

/**
 * Validates an untrusted body; `error` is English diagnostic text the route
 * turns into a 400. `attach` is never parsed: the session id comes from the
 * start the server itself runs, so no request body can set one.
 */
export function parseTodoRequest(raw: unknown): TodoRequestParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "Expected a JSON object" };
  const body = raw as Record<string, unknown>;
  const action = body.action;
  if (action === "add") {
    const title = todoTitle(body.title);
    if (!title) return { ok: false, error: "title is required" };
    const project = todoProject(body.project);
    if (!project) return { ok: false, error: "project is required" };
    const note = todoNote(body.note);
    return {
      ok: true,
      request: {
        action: "add",
        title,
        ...(note ? { note } : {}),
        project,
      },
    };
  }
  if (action === "update") {
    const id = parseId(body.id);
    if (!id.ok) return id;
    const title = todoTitle(body.title);
    const project = todoProject(body.project);
    // Absent leaves a note alone; null (or an empty one) removes it.
    const note = body.note === undefined ? undefined : parseNote(body.note);
    if (title === undefined && note === undefined && project === undefined) {
      return { ok: false, error: "nothing to update" };
    }
    const request: TodoUpdateRequest = { action: "update", id: id.id };
    if (title !== undefined) request.title = title;
    if (note !== undefined) request.note = note;
    if (project !== undefined) request.project = project;
    return { ok: true, request };
  }
  if (action === "complete" || action === "reopen" || action === "delete") {
    const id = parseId(body.id);
    if (!id.ok) return id;
    return { ok: true, request: { action, id: id.id } };
  }
  return { ok: false, error: "Unknown action" };
}

/**
 * One change: the same object back means "nothing changed", and the caller then
 * skips the write. A request that names no real difference (an update with the
 * values the todo already has, a second complete, a repeated attach) returns
 * `state` itself.
 */
export function applyTodoRequest(
  state: TodosState,
  request: TodoRequest,
  context: { now: number; newId?: () => string; doneBy?: TodoDoneBy },
): TodosState {
  // A caller's clock is stored the way the file keeps it: a time the next read
  // would drop would otherwise be a change that leaves nothing behind.
  const now = timestamp(context.now) ?? 0;
  if (request.action === "add") {
    if (state.todos.length >= MAX_TODOS) return state;
    // The same rules as `validTodo`, so what is stored here is what the next
    // read of the file keeps.
    const title = todoTitle(request.title);
    const project = todoProject(request.project);
    if (title === undefined || project === undefined) return state;
    const note = request.note === undefined ? undefined : todoNote(request.note);
    const id = context.newId ? context.newId() : randomTodoId(new Set(state.todos.map((todo) => todo.id)));
    // An injected id the file could not carry is no id: storing it would make a
    // todo the next read drops.
    if (!validId(id)) return state;
    const todo: Todo = {
      id,
      title,
      ...(note ? { note } : {}),
      project,
      createdAt: now,
      updatedAt: now,
      status: "open",
    };
    return { ...state, todos: [...state.todos, todo] };
  }
  if (request.action === "delete") {
    const todos = state.todos.filter((todo) => todo.id !== request.id);
    return todos.length === state.todos.length ? state : { ...state, todos };
  }
  const index = state.todos.findIndex((todo) => todo.id === request.id);
  if (index === -1) return state;
  const current = state.todos[index];
  let next: Todo;
  if (request.action === "update") {
    const title = request.title === undefined ? undefined : todoTitle(request.title);
    // `null` and a note with no text both remove it, so the in-memory value and
    // the value the next read keeps cannot disagree.
    const note = request.note === undefined || request.note === null ? undefined : todoNote(request.note);
    const project = request.project === undefined ? undefined : todoProject(request.project);
    const nextTitle = title ?? current.title;
    const nextNote = request.note === undefined ? current.note : note;
    const nextProject = project ?? current.project;
    if (nextTitle === current.title && nextNote === current.note && nextProject === current.project) return state;
    const updated: Todo = { ...current, title: nextTitle, project: nextProject, updatedAt: now };
    if (nextNote === undefined) delete updated.note;
    else updated.note = nextNote;
    next = updated;
  } else if (request.action === "attach") {
    // A session id the file could not have carried is no session id at all.
    if (!validSessionId(request.sessionId)) return state;
    // A new run stamps the same session id only when the previous one is still
    // the latest: a repeated start would otherwise look like a change.
    if (current.sessionId === request.sessionId) return state;
    next = { ...current, sessionId: request.sessionId, updatedAt: now };
  } else if (request.action === "complete") {
    if (current.status === "done") return state;
    next = { ...current, status: "done", doneAt: now, doneBy: context.doneBy ?? "user", updatedAt: now };
  } else {
    if (current.status === "open") return state;
    // Both the time and the author of the old completion go: keeping either
    // would leave a field that contradicts the state it belongs to.
    const reopened: Todo = { ...current, status: "open", updatedAt: now };
    delete reopened.doneAt;
    delete reopened.doneBy;
    next = reopened;
  }
  const todos = [...state.todos];
  todos[index] = next;
  return { ...state, todos };
}

/** Whether the todo's session is running decides between "running" and "awaiting confirmation"; a deleted session reads as awaiting confirmation too. */
export function todoDisplayStatus(todo: Todo, runningSessionIds: ReadonlySet<string>): TodoDisplayStatus {
  if (todo.status === "done") return "done";
  if (!todo.sessionId) return "open";
  return runningSessionIds.has(todo.sessionId) ? "running" : "confirm";
}

/** The first message of a run: the task itself, plus the tool call that ends it, so an unfinished run never claims to be done. */
export function todoStartPrompt(todo: Pick<Todo, "title" | "note">): string {
  const lines = [`处理这个待办：`, "", todo.title];
  if (todo.note) lines.push("", todo.note);
  lines.push("", "完成之后调用 todo_complete 工具，把这条待办标记为已完成。");
  return lines.join("\n");
}

/** Eight hex characters `taken` lacks: a duplicate id would let one request complete or delete two todos. */
function randomTodoId(taken: ReadonlySet<string>): string {
  let id: string;
  do {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    id = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } while (taken.has(id));
  return id;
}
