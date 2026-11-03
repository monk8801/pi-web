"use client";

// The right panel's to-do list. Rows are grouped by project, one line each, and
// a click on a row starts that to-do in its project (the design's D4): a session
// already running is opened instead, a done row does nothing.
//
// The state shown is derived, never stored (`todoDisplayStatus`): running, done
// and "waiting for your confirmation" all come from the to-do plus the ids the
// running poll reports, so a stale write can never leave a wrong row behind.

import { useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TodoAction } from "@/hooks/useTodos";
import { todoDisplayStatus, type Todo, type TodoDisplayStatus } from "@/lib/todos-shared";

export interface TodoRowModel { todo: Todo; display: TodoDisplayStatus }
export interface TodoGroupModel { project: string; label: string; rows: TodoRowModel[] }

/** Unfinished first (running, awaiting confirmation, open), done at the bottom, newest first within each. */
const DISPLAY_ORDER: Record<TodoDisplayStatus, number> = { running: 0, confirm: 1, open: 2, done: 3 };

function folderName(project: string): string {
  const parts = project.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? project;
}

export function groupTodos(
  todos: readonly Todo[],
  runningSessionIds: ReadonlySet<string>,
  projectNames: Readonly<Record<string, string>>,
): TodoGroupModel[] {
  const groups = new Map<string, TodoGroupModel>();
  for (const todo of todos) {
    const display = todoDisplayStatus(todo, runningSessionIds);
    const group = groups.get(todo.project) ?? {
      project: todo.project,
      label: projectNames[todo.project] ?? folderName(todo.project),
      rows: [],
    };
    group.rows.push({ todo, display });
    groups.set(todo.project, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    rows: [...group.rows].sort((a, b) => {
      const byState = DISPLAY_ORDER[a.display] - DISPLAY_ORDER[b.display];
      if (byState !== 0) return byState;
      return (b.todo.doneAt ?? b.todo.updatedAt) - (a.todo.doneAt ?? a.todo.updatedAt);
    }),
  }));
}

interface Props {
  /** The project a new to-do goes to: the session's, or the sidebar's current one. */
  cwd: string | null;
  /** Session ids the running poll reports; a to-do whose session is here is running. */
  runningSessionIds: ReadonlySet<string>;
  todos: Todo[];
  /** Display names the user gave projects, by root. */
  projectNames?: Readonly<Record<string, string>>;
  onOpenSession(sessionId: string, cwd: string): void;
  /** Starts the to-do; resolves with the session to open, if one was started. */
  onStart(todo: Todo): Promise<string | undefined>;
  run(action: TodoAction): Promise<{ sessionId?: string }>;
  error?: string | null;
}

export function TodoPanel({ cwd, runningSessionIds, todos, projectNames = {}, onOpenSession, onStart, run, error }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const groups = useMemo(() => groupTodos(todos, runningSessionIds, projectNames), [todos, runningSessionIds, projectNames]);

  /** A click or a key on a row: open its run, or start one. */
  const open = (todo: Todo, display: TodoDisplayStatus) => {
    if (display === "done") return;
    if (display === "running" && todo.sessionId) {
      onOpenSession(todo.sessionId, todo.project);
      return;
    }
    void onStart(todo).then((sessionId) => {
      if (sessionId) onOpenSession(sessionId, todo.project);
    });
  };

  const add = async () => {
    const title = draft.trim();
    if (!title || !cwd) return;
    setDraft("");
    await run({ kind: "add", title, project: cwd });
  };

  return (
    <div className="todo-panel" data-testid="todo-panel">
      <div className="todo-panel-add">
        <input
          data-testid="todo-add"
          value={draft}
          placeholder={t(cwd ? "todos.addPlaceholder" : "todos.addNeedsProject")}
          aria-label={t("todos.addPlaceholder")}
          disabled={!cwd}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // A composing IME (Chinese, Japanese) owns Enter: only a real Enter adds.
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void add();
          }}
        />
      </div>
      {error && <div className="todo-panel-error" role="alert">{error}</div>}
      {groups.length === 0 && <div className="todo-panel-empty" data-testid="todo-empty">{t("todos.empty")}</div>}
      {groups.map((group) => (
        <section className="todo-group" key={group.project}>
          <h3 className="todo-group-label" title={group.project}>{group.label}</h3>
          {group.rows.map(({ todo, display }) => (
            <div
              key={todo.id}
              className={`todo-row is-${display}`}
              data-testid={`todo-row-${todo.id}`}
              data-project={group.project}
              data-state={display}
              title={todo.note ?? todo.title}
              // The row is the action, so it is reachable and named as a button;
              // a done row has nothing to start and takes no focus.
              {...(display === "done" ? {} : { role: "button", tabIndex: 0 })}
              onClick={() => open(todo, display)}
              onKeyDown={(event) => {
                if (display === "done" || event.target !== event.currentTarget) return;
                if (event.key !== "Enter" && event.key !== " ") return;
                // Space on a focused row must not scroll the panel.
                event.preventDefault();
                open(todo, display);
              }}
            >
              <span className="todo-row-state" aria-hidden="true" />
              <span className="todo-row-title">{todo.title}</span>
              <span className="todo-row-actions">
                {display === "confirm" && (
                  <button
                    type="button"
                    className="todo-row-confirm"
                    title={t("todos.confirm")}
                    onClick={(event) => {
                      event.stopPropagation();
                      void run({ kind: "complete", id: todo.id });
                    }}
                  >
                    {t("todos.confirmDone")}
                  </button>
                )}
                <button
                  type="button"
                  className="todo-row-more"
                  title={display === "done" ? t("todos.reopen") : t("todos.delete")}
                  aria-label={display === "done" ? t("todos.reopen") : t("todos.delete")}
                  onClick={(event) => {
                    event.stopPropagation();
                    void run(display === "done" ? { kind: "reopen", id: todo.id } : { kind: "delete", id: todo.id });
                  }}
                >
                  {display === "done" ? "↺" : "✕"}
                </button>
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
