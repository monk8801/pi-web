// What a to-do's right-click menu offers, decided without React: the panel
// renders these as `SidebarMenu` items, and the rules are testable on their own.
//
// Running a to-do lives here rather than on a plain click: a click on a row is
// one slip away from starting a pi session in a project, and this menu is where
// a deliberate action belongs. A running to-do's "Run" is shown, disabled, so
// the menu keeps its shape while the run is live.

import { todoDisplayStatus, type Todo, type TodoDisplayStatus } from "@/lib/todos-shared";

export type TodoMenuCommand = "run" | "edit" | "move" | "done" | "reopen" | "delete";

/** `disabledReason` is a translation key when it is one of the `todos.*` keys. */
export interface TodoMenuEntry {
  command: TodoMenuCommand;
  disabled: boolean;
}

/**
 * The entries, in order, for a to-do in that display state: run or reopen
 * first, then moving it, then the destructive one alone at the end.
 */
export function todoMenuItems(display: TodoDisplayStatus): TodoMenuEntry[] {
  // A finished to-do is a record: it cannot be edited or moved, only reopened
  // (which makes it editable again) or deleted.
  if (display === "done") {
    return [
      { command: "reopen", disabled: false },
      { command: "delete", disabled: false },
    ];
  }
  return [
    // A run that is already live cannot be started again.
    { command: "run", disabled: display === "running" },
    // A person may always close a to-do by hand: a run that ended without saying
    // so is the usual case, but a task done outside pi (or one nobody watched)
    // is just as finished. A running session keeps running; only the to-do ends.
    { command: "done", disabled: false },
    { command: "edit", disabled: false },
    { command: "move", disabled: false },
    { command: "delete", disabled: false },
  ];
}

export interface TodoProjectChoice {
  root: string;
  label: string;
  current: boolean;
}

/** The projects a to-do can be moved to: the sidebar's own list, current one marked. */
export function todoProjectChoices(
  projects: readonly { root: string; alias?: string }[],
  current: string,
): TodoProjectChoice[] {
  const seen = new Set<string>();
  const choices: TodoProjectChoice[] = [];
  for (const project of projects) {
    if (seen.has(project.root)) continue;
    seen.add(project.root);
    choices.push({ root: project.root, label: project.alias ?? folderName(project.root), current: project.root === current });
  }
  return choices;
}

/** `todoDisplayStatus()` for a to-do, from the ids a running poll reports. */
export function displayOf(todo: Todo, runningSessionIds: ReadonlySet<string>): TodoDisplayStatus {
  return todoDisplayStatus(todo, runningSessionIds);
}

function folderName(project: string): string {
  return project.split(/[\\/]/).filter(Boolean).at(-1) ?? project;
}
