"use client";

// The to-do panel's data: one action at a time, the server answering with the
// whole list. No optimistic merge — the list is small, and the server's answer
// (with its revision) is the truth the next poll agrees with.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Todo } from "@/lib/todos-shared";

export type TodoAction =
  | { kind: "add"; title: string; project: string; note?: string }
  | { kind: "update"; id: string; title?: string; note?: string | null; project?: string }
  | { kind: "complete"; id: string }
  | { kind: "reopen"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "start"; id: string };

/** The body the route parses: the same fields, with `action` instead of `kind`. */
export function todoRequestBody(action: TodoAction): Record<string, unknown> {
  const { kind, ...rest } = action;
  return { action: kind, ...rest };
}

export function todoErrorMessage(status: number, body: unknown): string {
  const message = (body as { error?: unknown } | null)?.error;
  return typeof message === "string" && message.length > 0 ? message : `HTTP ${status}`;
}

export interface TodosApi {
  todos: Todo[];
  revision: number;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  /** Runs one action; returns the started session's id for `start`. */
  run(action: TodoAction): Promise<{ sessionId?: string }>;
}

export function useTodos(): TodosApi {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/todos", { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(todoErrorMessage(res.status, body));
      const answer = body as { todos: Todo[]; revision: number };
      setTodos(answer.todos);
      setRevision(answer.revision);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(async (action: TodoAction) => {
    try {
      const res = await fetch("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(todoRequestBody(action)),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(todoErrorMessage(res.status, body));
        return {};
      }
      const answer = body as { todos: Todo[]; revision: number; sessionId?: string };
      setTodos(answer.todos);
      setRevision(answer.revision);
      setError(null);
      return answer.sessionId ? { sessionId: answer.sessionId } : {};
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return {};
    }
  }, []);

  return useMemo(() => ({ todos, revision, loading, error, refresh, run }), [todos, revision, loading, error, refresh, run]);
}
