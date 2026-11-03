import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { TodoPanel, groupTodos } = await jiti.import("./TodoPanel.tsx");

const h = React.createElement;
const now = 1_700_000_000_000;

const todo = (overrides) => ({
  id: "aaaaaaaa",
  title: "写测试",
  project: "/work/app",
  status: "open",
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

function render(props) {
  return renderToStaticMarkup(h(I18nProvider, { locale: "en" }, h(TodoPanel, {
    cwd: "/work/app",
    runningSessionIds: new Set(),
    todos: [],
    projectNames: {},
    onOpenSession: () => {},
    onStart: async () => undefined,
    run: async () => ({}),
    error: null,
    ...props,
  })));
}

test("todos group by project, unfinished first and done at the bottom", () => {
  const groups = groupTodos([
    todo({ id: "bbbbbbbb", title: "已完成", status: "done", doneAt: now }),
    todo({ id: "aaaaaaaa", title: "进行中", sessionId: "s-1" }),
    todo({ id: "cccccccc", title: "未开始" }),
  ], new Set(["s-1"]), {});
  assert.equal(groups.length, 1);
  assert.equal(groups[0].project, "/work/app");
  assert.deepEqual(groups[0].rows.map((row) => row.todo.title), ["进行中", "未开始", "已完成"]);
  assert.deepEqual(groups[0].rows.map((row) => row.display), ["running", "open", "done"]);
});

test("a waiting to-do and a running one are told apart by the running ids", () => {
  const waiting = groupTodos([todo({ sessionId: "s-1" })], new Set(), {});
  const running = groupTodos([todo({ sessionId: "s-1" })], new Set(["s-1"]), {});
  assert.equal(waiting[0].rows[0].display, "confirm");
  assert.equal(running[0].rows[0].display, "running");
});

test("a group is named by the project's display name, else its folder", () => {
  assert.equal(groupTodos([todo({})], new Set(), { "/work/app": "Pi Web" })[0].label, "Pi Web");
  assert.equal(groupTodos([todo({})], new Set(), {})[0].label, "app");
  assert.equal(groupTodos([todo({ project: "C:\\work\\win-app" })], new Set(), {})[0].label, "win-app");
});

test("the panel renders the composer, one group per project and one row per to-do", () => {
  const html = render({ todos: [todo({}), todo({ id: "bbbbbbbb", title: "另一件", project: "/work/other" })] });
  assert.match(html, /data-testid="todo-add"/);
  assert.match(html, /写测试/);
  assert.match(html, /另一件/);
  assert.match(html, /data-testid="todo-row-aaaaaaaa"/);
  assert.match(html, /data-testid="todo-row-bbbbbbbb"/);
});

test("an empty list says so, and a failure is announced", () => {
  assert.match(render({}), /data-testid="todo-empty"/);
  const withError = render({ error: "Another process holds the todos lock" });
  assert.match(withError, /role="alert"/);
  assert.match(withError, /holds the todos lock/);
});

test("only a waiting row offers the confirm click; every row offers its menu", () => {
  const waiting = render({ todos: [todo({ sessionId: "s-1" })] });
  assert.match(waiting, /class="todo-row-confirm"/);
  const done = render({ todos: [todo({ status: "done", doneAt: now })] });
  assert.doesNotMatch(done, /class="todo-row-confirm"/);
  // Nothing runs on a click: the row and its ⋯ both open the menu instead.
  assert.match(done, /class="todo-row-more"/);
  assert.match(done, /aria-haspopup="menu"/);
  const open = render({ todos: [todo({})] });
  assert.match(open, /class="todo-row-more"/);
  assert.doesNotMatch(open, /↺/);
});

test("without a project to add to, the composer is disabled and says why", () => {
  const html = render({ cwd: null });
  assert.match(html, /disabled=""/);
  assert.match(html, /Open a project first/);
});

test("a row is a button to the keyboard, and a done row is not", () => {
  const open = render({ todos: [todo({})] });
  assert.match(open, /data-state="open"[^>]*role="button" tabindex="0"/);
  // The row's own buttons keep the keyboard to themselves.
  assert.match(open, /class="todo-row-more"/);
  const done = render({ todos: [todo({ status: "done", doneAt: now })] });
  assert.doesNotMatch(done, /role="button" tabindex="0"/);
});
