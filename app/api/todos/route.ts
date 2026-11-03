// The to-do list's API: `GET` reads it, `POST` makes one change.
//
// Every action but `start` is a pure edit of `pi-web-todos.json`
// (`lib/todos.ts` + `lib/todos-shared.ts`). `start` needs a session, so it runs
// in `lib/todos-start.ts`. A failed edit answers with a `reason` the panel shows
// as its error line; a lock held by another process is a 409, not a 500.

import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readTodos, TodosLockedError, updateTodos } from "@/lib/todos";
import { parseTodoRequest } from "@/lib/todos-shared";
import { startTodo } from "@/lib/todos-start";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, reason: string, error: string) {
  return NextResponse.json({ error, reason }, { status, headers: NO_STORE });
}

// GET /api/todos
export async function GET() {
  const state = readTodos();
  return NextResponse.json({ todos: state.todos, revision: state.revision }, { headers: NO_STORE });
}

// POST /api/todos - one change; answers with the list after it.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "content-type", "Content-Type must be application/json");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "invalid-request", "Invalid JSON body");
  }
  const parsed = parseTodoRequest(body);
  if (!parsed.ok) return refusal(400, "invalid-request", parsed.error);

  const { request } = parsed;
  try {
    if (request.action === "start") {
      const result = await startTodo(request.id);
      if (!result.ok) return refusal(result.status, result.reason, result.error);
      return NextResponse.json(
        { todos: result.state.todos, revision: result.state.revision, sessionId: result.sessionId },
        { headers: NO_STORE },
      );
    }
    // A request that names no to-do is a 404 rather than a silent no-op: the panel
    // then knows its list is stale instead of showing a change that never happened.
    if (request.action !== "add" && !readTodos().todos.some((todo) => todo.id === request.id)) {
      return refusal(404, "not-found", "No such todo");
    }
    const state = await updateTodos(request, { doneBy: "user" });
    return NextResponse.json({ todos: state.todos, revision: state.revision }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof TodosLockedError) return refusal(409, "locked", error.message);
    return refusal(500, "write-failed", error instanceof Error ? error.message : String(error));
  }
}
