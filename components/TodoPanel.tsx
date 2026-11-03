"use client";

// The right panel's to-do list. Rows are grouped by project, one line each, and
// nothing is ever started by accident: a row opens its menu (right-click, or a
// click for touch and keyboard), and the menu's "Run" starts it — a plain click
// used to start a pi session, one slip away from the wrong project.
//
// The state shown is derived, never stored (`todoDisplayStatus`): running, done
// and "waiting for your confirmation" all come from the to-do plus the ids the
// running poll reports, so a stale write can never leave a wrong row behind.

import { useId, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { TodoAction } from "@/hooks/useTodos";
import { todoDisplayStatus, type Todo, type TodoDisplayStatus } from "@/lib/todos-shared";
import { SidebarMenu, type SidebarMenuItem } from "./SidebarMenu";
import { todoMenuItems, todoProjectChoices, type TodoMenuCommand } from "./todo-menu";

export interface TodoRowModel { todo: Todo; display: TodoDisplayStatus }
export interface TodoGroupModel { project: string; label: string; rows: TodoRowModel[] }

/** Unfinished first (running, awaiting confirmation, open), done at the bottom, newest first within each. */
const DISPLAY_ORDER: Record<TodoDisplayStatus, number> = { running: 0, confirm: 1, open: 2, done: 3 };

/** Wide enough for a title and a line of actions; the edit form needs room for a long note. */
const MENU_WIDTH = 200;
const MENU_WIDTH_PROJECTS = 260;
const MENU_WIDTH_EDIT = 460;

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

interface MenuState {
  todo: Todo;
  display: TodoDisplayStatus;
  x: number;
  y: number;
  /** "projects" and "edit" swap the body; only "actions" is the item list. */
  mode: "actions" | "projects" | "edit";
}

interface Props {
  /** The project a new to-do goes to: the session's, or the sidebar's current one. */
  cwd: string | null;
  /** Session ids the running poll reports; a to-do whose session is here is running. */
  runningSessionIds: ReadonlySet<string>;
  todos: Todo[];
  /** Display names the user gave projects, by root. */
  projectNames?: Readonly<Record<string, string>>;
  /** Every project the sidebar knows: where a to-do can be moved. */
  projects?: readonly { root: string; alias?: string }[];
  onOpenSession(sessionId: string, cwd: string): void;
  /** Runs the to-do; resolves with the session to open, if one was started. */
  onStart(todo: Todo): Promise<string | undefined>;
  run(action: TodoAction): Promise<{ sessionId?: string }>;
  error?: string | null;
}

export function TodoPanel({
  cwd,
  runningSessionIds,
  todos,
  projectNames = {},
  projects = [],
  onOpenSession,
  onStart,
  run,
  error,
}: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  // The edit form's fields; filled when the menu swaps to it.
  const [edit, setEdit] = useState<{ title: string; note: string } | null>(null);
  const editTitleId = useId();
  const editNoteId = useId();
  const groups = useMemo(() => groupTodos(todos, runningSessionIds, projectNames), [todos, runningSessionIds, projectNames]);

  const add = async () => {
    const title = draft.trim();
    if (!title || !cwd) return;
    setDraft("");
    await run({ kind: "add", title, project: cwd });
  };

  /** A row's click, right-click or key: the menu, never the run itself. */
  const openMenu = (todo: Todo, display: TodoDisplayStatus, point?: { x: number; y: number }) => {
    setMenu({
      todo,
      display,
      x: point?.x ?? 0,
      y: point?.y ?? 0,
      mode: "actions",
    });
  };

  const start = async () => {
    const target = menu;
    setMenu(null);
    if (!target) return;
    const sessionId = target.todo.sessionId && target.display === "running"
      ? target.todo.sessionId
      : await onStart(target.todo);
    if (sessionId) onOpenSession(sessionId, target.todo.project);
  };

  const command = (kind: TodoMenuCommand) => {
    const target = menu;
    if (!target) return;
    const { todo } = target;
    if (kind === "run") return void start();
    if (kind === "edit") {
      setEdit({ title: todo.title, note: todo.note ?? "" });
      setMenu({ ...target, mode: "edit" });
      return;
    }
    if (kind === "move") {
      setMenu({ ...target, mode: "projects" });
      return;
    }
    setMenu(null);
    if (kind === "done") return void run({ kind: "complete", id: todo.id });
    if (kind === "reopen") return void run({ kind: "reopen", id: todo.id });
    return void run({ kind: "delete", id: todo.id });
  };

  /** Save the edit form: a blank title changes nothing, an empty note clears it. */
  const saveEdit = async () => {
    const target = menu;
    const fields = edit;
    if (target === null || fields === null) return;
    const title = fields.title.trim();
    if (title.length === 0) return;
    setMenu(null);
    const note = fields.note.trim();
    await run({ kind: "update", id: target.todo.id, title, note: note.length === 0 ? null : note });
  };

  // Not memoised: a handful of entries, rebuilt from the open menu's state.
  const menuItems = (): SidebarMenuItem[] => {
    if (!menu) return [];
    if (menu.mode === "projects") {
      const choices = todoProjectChoices(projects, menu.todo.project);
      return choices.length === 0
        ? [{ type: "item", id: "none", label: t("todos.noProjects"), disabled: true, onSelect: () => {} }]
        : choices.map((choice) => ({
            type: "item" as const,
            id: `project:${choice.root}`,
            label: choice.label,
            title: choice.root,
            checked: choice.current,
            mono: true,
            onSelect: () => {
              const target = menu.todo;
              setMenu(null);
              if (choice.current) return;
              void run({ kind: "update", id: target.id, project: choice.root });
            },
          }));
    }
    return todoMenuItems(menu.display).map((entry) => ({
      type: "item" as const,
      id: entry.command,
      label: t(menuLabelKey(entry.command)),
      ...(entry.command === "delete" ? { danger: true } : {}),
      ...(entry.command === "run" && entry.disabled ? { disabled: true, disabledReason: t("todos.alreadyRunning") } : {}),
      // Moving and editing swap the menu's body: the menu must stay open for it.
      onSelect: (event) => {
        if (entry.command === "move" || entry.command === "edit") event.keepOpen();
        command(entry.command);
      },
    }));
  };
  const items = menuItems();

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
              // Only two ways in, both deliberate: a right-click anywhere on the
              // row, or its ⋯ button (which the keyboard reaches). A plain click
              // on the row does nothing.
              onContextMenu={(event) => {
                event.preventDefault();
                openMenu(todo, display, { x: event.clientX, y: event.clientY });
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
                  title={t("todos.rowMenu")}
                  aria-label={t("todos.rowMenu")}
                  aria-haspopup="menu"
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openMenu(todo, display, { x: rect.left, y: rect.bottom });
                  }}
                >
                  ⋯
                </button>
              </span>
            </div>
          ))}
        </section>
      ))}
      <SidebarMenu
        open={menu !== null}
        anchor={menu ? { kind: "point", x: menu.x, y: menu.y } : null}
        sheet={isMobile}
        ariaLabel={menu ? menu.todo.title : t("todos.rowMenu")}
        title={menu?.todo.title}
        items={menu?.mode === "edit" ? undefined : items}
        filter={menu?.mode === "projects"
          ? { placeholder: t("todos.filterProjects"), emptyLabel: t("todos.noProjects") }
          : undefined}
        width={menu?.mode === "edit" ? MENU_WIDTH_EDIT : menu?.mode === "projects" ? MENU_WIDTH_PROJECTS : MENU_WIDTH}
        cancelLabel={t("todos.cancel")}
        focusKey={menu?.mode}
        onClose={() => setMenu(null)}
      >
        {menu?.mode === "edit" && edit !== null ? (
          // The same shape as the worktree form (components/WorktreeCreateForm.tsx):
          // an autofocused field, then the two buttons.
          <div className="sidebar-worktree-form">
            <div className="sidebar-menu-header">{t("todos.edit")}</div>
            <label className="todo-edit-label" htmlFor={editTitleId}>{t("todos.editTitle")}</label>
            <input
              id={editTitleId}
              className="sidebar-worktree-input"
              data-sidebar-menu-autofocus=""
              value={edit.title}
              aria-label={t("todos.editTitle")}
              onChange={(event) => setEdit({ ...edit, title: event.target.value })}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void saveEdit();
              }}
            />
            <label className="todo-edit-label" htmlFor={editNoteId}>{t("todos.editNote")}</label>
            <textarea
              id={editNoteId}
              className="sidebar-worktree-input todo-edit-note"
              value={edit.note}
              rows={8}
              aria-label={t("todos.editNote")}
              onChange={(event) => setEdit({ ...edit, note: event.target.value })}
            />
            <div className="sidebar-worktree-form-buttons">
              <button type="button" className="sidebar-worktree-create" disabled={edit.title.trim().length === 0} onClick={() => void saveEdit()}>
                {t("todos.save")}
              </button>
              <button type="button" className="sidebar-worktree-cancel" onClick={() => setMenu(null)}>
                {t("todos.cancel")}
              </button>
            </div>
          </div>
        ) : null}
      </SidebarMenu>
    </div>
  );
}

function menuLabelKey(kind: TodoMenuCommand): string {
  switch (kind) {
    case "run": return "todos.run";
    case "edit": return "todos.edit";
    case "move": return "todos.moveProject";
    case "done": return "todos.markDone";
    case "reopen": return "todos.reopen";
    default: return "todos.delete";
  }
}
