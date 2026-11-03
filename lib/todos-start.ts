// Starting a to-do: the part that needs a session, not a rule.
//
// `POST /api/todos { action: "start" }` lands here. It never starts a second
// session for a to-do that is already running, refuses a project whose folder is
// gone, and records the new session id on the to-do so the panel can show its
// state and open it. The session itself is created exactly as `/api/agent/new`
// creates one (`lib/rpc-manager.ts`), with `todoId` so that session — and only
// that one — gets the `todo_complete` tool (`lib/builtin-todo-extension.ts`).

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { allowFileRoot } from "./file-access";
import { getRunningWrapper, startRpcSession } from "./rpc-manager";
import { invalidateSessionListCache } from "./session-reader";
import { readTodos, updateTodos } from "./todos";
import { todoStartPrompt, type TodosState } from "./todos-shared";

export type TodoStartResult =
  | { ok: true; sessionId: string; state: TodosState }
  | { ok: false; status: number; reason: string; error: string };

/** What starting needs from the world; tests replace all three. */
export interface TodoStartCaller {
  /** Is the project folder still there? */
  exists(cwd: string): boolean;
  /** Is that session still alive? Starting a second one would run the to-do twice. */
  isRunning(sessionId: string): boolean;
  startSession(options: { cwd: string; message: string; todoId: string }): Promise<{ sessionId: string }>;
}

export function createStartTodo(caller: TodoStartCaller) {
  return async function startTodo(id: string): Promise<TodoStartResult> {
    const state = readTodos();
    const todo = state.todos.find((entry) => entry.id === id);
    if (!todo) return { ok: false, status: 404, reason: "not-found", error: "No such todo" };
    if (!caller.exists(todo.project)) {
      return { ok: false, status: 400, reason: "cwd-missing", error: `The project folder no longer exists: ${todo.project}` };
    }
    // Already running: open that session instead of starting a second one.
    if (todo.sessionId && caller.isRunning(todo.sessionId)) {
      return { ok: true, sessionId: todo.sessionId, state };
    }
    const { sessionId } = await caller.startSession({
      cwd: todo.project,
      message: todoStartPrompt(todo),
      todoId: todo.id,
    });
    const next = await updateTodos({ action: "attach", id: todo.id, sessionId });
    return { ok: true, sessionId, state: next };
  };
}

export const startTodo = createStartTodo({
  exists: (cwd) => existsSync(cwd),
  isRunning: (sessionId) => getRunningWrapper(sessionId) !== undefined,
  startSession: async ({ cwd, message, todoId }) => {
    // The one-time key keeps `startRpcSession`'s lock from colliding with real ids.
    const tempKey = `__todo__${randomUUID()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, { todoId });
    allowFileRoot(cwd);
    invalidateSessionListCache();
    await session.send({ type: "prompt", message });
    return { sessionId: realSessionId };
  },
});
