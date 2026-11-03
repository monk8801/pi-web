import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The wiring this feature needs is spread over three files that are hard to
// render in isolation (AppShell mounts the whole page, TabBar takes the panel's
// tabs); read them instead, so removing a piece fails here rather than in a
// browser nobody opened.
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const tabBar = await readFile(new URL("./TabBar.tsx", import.meta.url), "utf8");
const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/sidebar.css", import.meta.url), "utf8");

test("the right panel can host the todo tab", () => {
  assert.match(tabBar, /kind\?: "terminal" \| "agent" \| "side" \| "todo"/);
  assert.match(tabBar, /todos\.tabLabel/);
  assert.match(shell, /<TodoPanel/);
  assert.match(shell, /kind: "todo" as const/);
  assert.match(shell, /setActiveFileTabId\("todo"\)/);
});

test("the sidebar's footer row opens the panel and shows the unfinished count", () => {
  assert.match(shell, /onOpenTodos=\{handleOpenTodos\}/);
  assert.match(shell, /todoCount=\{todoCount\}/);
  assert.match(sidebar, /onOpenTodos\?: \(\) => void;/);
  assert.match(sidebar, /onOpenTodos: \(\) => onOpenTodos\?\.\(\)/);
});

test("a started session is opened the way a created one is", () => {
  // A session the server already made has no draft to claim: the early return
  // must let a null key through.
  assert.match(shell, /sourceDraftKey: string \| null/);
  assert.match(shell, /sourceDraftKey !== null && activeNewSessionDraftKeyRef\.current !== sourceDraftKey/);
  assert.match(shell, /handleSessionCreated\(session, null\)/);
});

test("the todo tab closes, and a fresh composer's draft is parked, not lost", () => {
  assert.match(shell, /if \(tabId === "todo"\) \{\s*setTodoTabOpen\(false\);/);
  assert.match(shell, /rekeyDraft\(activeDraftKey, parkedNewSessionDraftKey\(activeDraftCwd\)\);\s*handleSessionCreated\(session, null\);/);
});

test("the panel's styles use the theme's tokens only, and the rows keep the 30px rhythm", () => {
  const rules = css.slice(css.indexOf(".todo-panel"));
  assert.ok(rules.length > 0, "no .todo-panel rule");
  assert.doesNotMatch(rules, /color-mix|#[0-9a-fA-F]{3,6}\b/, "no new colors");
  assert.match(rules, /\.todo-row \{[^}]*height: 30px;/);
});
