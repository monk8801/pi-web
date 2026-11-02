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
/** Eight hex characters, the style of `session-ui-state.json`'s keys. */
const TODO_ID_PATTERN = /^[0-9a-f]{8}$/;

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
export interface TodoUpdateRequest { action: "update"; id: string; title?: string; note?: string; project?: string }
export interface TodoIdRequest { action: "complete" | "reopen" | "delete"; id: string }
/** The server fills in the session id after `start`; no client sends it. */
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

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && TODO_ID_PATTERN.test(value);
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** One entry as the file may carry it; null when it is not a todo this module can work with. */
function validTodo(raw: unknown): Todo | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const id = entry.id;
  const title = trimmed(entry.title);
  const project = trimmed(entry.project);
  const status = entry.status === "done" ? "done" : entry.status === "open" ? "open" : null;
  if (!validId(id) || title === undefined || project === undefined || status === null) return null;
  const createdAt = timestamp(entry.createdAt) ?? 0;
  const updatedAt = timestamp(entry.updatedAt) ?? createdAt;
  const note = trimmed(entry.note);
  const sessionId = trimmed(entry.sessionId);
  // The completion's time and author are kept only while the todo is done:
  // a reopen drops both, so a stale pair cannot outlive its state.
  const doneAt = timestamp(entry.doneAt);
  const doneBy = entry.doneBy === "agent" ? "agent" : entry.doneBy === "user" ? "user" : undefined;
  return {
    id,
    title: title.slice(0, MAX_TODO_TITLE_LENGTH),
    ...(note ? { note: note.slice(0, MAX_TODO_NOTE_LENGTH) } : {}),
    project: project.slice(0, MAX_PROJECT_LENGTH),
    ...(sessionId ? { sessionId } : {}),
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
  const revision = typeof document.revision === "number" && Number.isFinite(document.revision) && document.revision >= 0
    ? Math.floor(document.revision)
    : 0;
  const list = Array.isArray(document.todos) ? document.todos : [];
  const todos: Todo[] = [];
  for (const entry of list) {
    const todo = validTodo(entry);
    if (todo) todos.push(todo);
    if (todos.length >= MAX_TODOS) break;
  }
  return { version: TODOS_VERSION, revision, todos };
}

/** Validates an untrusted body; `error` is English diagnostic text the route turns into a 400. */
export function parseTodoRequest(raw: unknown): TodoRequestParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "Expected a JSON object" };
  const body = raw as Record<string, unknown>;
  const action = body.action;
  if (action === "add") {
    const title = trimmed(body.title);
    const project = trimmed(body.project);
    if (!title) return { ok: false, error: "title is required" };
    if (!project) return { ok: false, error: "project is required" };
    const note = trimmed(body.note);
    return {
      ok: true,
      request: {
        action: "add",
        title: title.slice(0, MAX_TODO_TITLE_LENGTH),
        ...(note ? { note: note.slice(0, MAX_TODO_NOTE_LENGTH) } : {}),
        project: project.slice(0, MAX_PROJECT_LENGTH),
      },
    };
  }
  if (action === "update") {
    if (!validId(body.id)) return { ok: false, error: "id is required" };
    const title = trimmed(body.title);
    const note = trimmed(body.note);
    const project = trimmed(body.project);
    if (title === undefined && note === undefined && project === undefined) {
      return { ok: false, error: "nothing to update" };
    }
    return {
      ok: true,
      request: {
        action: "update",
        id: body.id,
        ...(title ? { title: title.slice(0, MAX_TODO_TITLE_LENGTH) } : {}),
        ...(note ? { note: note.slice(0, MAX_TODO_NOTE_LENGTH) } : {}),
        ...(project ? { project: project.slice(0, MAX_PROJECT_LENGTH) } : {}),
      },
    };
  }
  if (action === "complete" || action === "reopen" || action === "delete") {
    if (!validId(body.id)) return { ok: false, error: "id is required" };
    return { ok: true, request: { action, id: body.id } };
  }
  if (action === "attach") {
    if (!validId(body.id)) return { ok: false, error: "id is required" };
    const sessionId = trimmed(body.sessionId);
    if (!sessionId) return { ok: false, error: "sessionId is required" };
    return { ok: true, request: { action: "attach", id: body.id, sessionId } };
  }
  return { ok: false, error: "Unknown action" };
}

/** One change: the same object back means "nothing changed", and the caller then skips the write. */
export function applyTodoRequest(
  state: TodosState,
  request: TodoRequest,
  context: { now: number; newId?: () => string; doneBy?: TodoDoneBy },
): TodosState {
  const { now } = context;
  if (request.action === "add") {
    if (state.todos.length >= MAX_TODOS) return state;
    const id = (context.newId ?? randomTodoId)();
    const todo: Todo = {
      id,
      title: request.title,
      ...(request.note ? { note: request.note } : {}),
      project: request.project,
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
    next = {
      ...current,
      ...(request.title ? { title: request.title } : {}),
      ...(request.note !== undefined ? { note: request.note } : {}),
      ...(request.project ? { project: request.project } : {}),
      updatedAt: now,
    };
  } else if (request.action === "attach") {
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
export function todoStartPrompt(todo: Pick<Todo, "id" | "title" | "note">): string {
  const lines = [`处理这个待办：`, "", todo.title];
  if (todo.note) lines.push("", todo.note);
  lines.push("", "完成之后调用 todo_complete 工具，把这条待办标记为已完成。");
  return lines.join("\n");
}

function randomTodoId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
