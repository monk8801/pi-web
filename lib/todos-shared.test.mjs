import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const {
  applyTodoRequest,
  emptyTodosState,
  normalizeTodosState,
  parseTodoRequest,
  todoDisplayStatus,
  todoStartPrompt,
} = await jiti.import("./todos-shared.ts");

const now = 1_700_000_000_000;
const base = () => ({
  ...emptyTodosState(),
  todos: [{
    id: "aaaaaaaa",
    title: "写测试",
    project: "/work/app",
    status: "open",
    createdAt: now,
    updatedAt: now,
  }],
});

test("a request is parsed into a known action or refused with a reason", () => {
  const added = parseTodoRequest({ action: "add", title: "  新待办  ", project: "/work/app" });
  assert.equal(added.ok, true);
  assert.equal(added.request.title, "新待办");
  assert.equal(parseTodoRequest({ action: "add", title: "   ", project: "/work/app" }).ok, false);
  assert.equal(parseTodoRequest({ action: "add", title: "x", project: "" }).ok, false);
  assert.equal(parseTodoRequest({ action: "nope" }).ok, false);
  assert.equal(parseTodoRequest({ action: "complete", id: "not-an-id" }).ok, false);
});

test("add appends with an id and timestamps, complete and reopen flip the state", () => {
  let state = applyTodoRequest(emptyTodosState(), { action: "add", title: "T", project: "/p" }, { now, newId: () => "deadbeef" });
  assert.deepEqual(state.todos.map((todo) => todo.id), ["deadbeef"]);
  assert.equal(state.todos[0].createdAt, now);
  state = applyTodoRequest(state, { action: "complete", id: "deadbeef" }, { now: now + 5, doneBy: "user" });
  assert.equal(state.todos[0].status, "done");
  assert.equal(state.todos[0].doneBy, "user");
  state = applyTodoRequest(state, { action: "reopen", id: "deadbeef" }, { now: now + 9 });
  assert.equal(state.todos[0].status, "open");
  assert.equal(state.todos[0].doneAt, undefined);
  assert.equal(state.todos[0].doneBy, undefined);
});

test("update, attach, delete and unknown ids change nothing they should not", () => {
  let state = applyTodoRequest(base(), { action: "update", id: "aaaaaaaa", title: "改标题", note: "备注" }, { now });
  assert.equal(state.todos[0].title, "改标题");
  assert.equal(state.todos[0].note, "备注");
  state = applyTodoRequest(state, { action: "attach", id: "aaaaaaaa", sessionId: "s-1" }, { now });
  assert.equal(state.todos[0].sessionId, "s-1");
  const untouched = applyTodoRequest(state, { action: "delete", id: "bbbbbbbb" }, { now });
  assert.equal(untouched.todos.length, 1);
  assert.deepEqual(applyTodoRequest(state, { action: "delete", id: "aaaaaaaa" }, { now }).todos, []);
});

test("the display state is derived, never stored", () => {
  const todo = base().todos[0];
  assert.equal(todoDisplayStatus(todo, new Set()), "open");
  const withSession = { ...todo, sessionId: "s-1" };
  assert.equal(todoDisplayStatus(withSession, new Set(["s-1"])), "running");
  assert.equal(todoDisplayStatus(withSession, new Set()), "confirm");
  assert.equal(todoDisplayStatus({ ...withSession, status: "done" }, new Set()), "done");
});

test("the first prompt names the task and asks for todo_complete", () => {
  const text = todoStartPrompt({ ...base().todos[0], note: "记得跑测试" });
  assert.match(text, /写测试/);
  assert.match(text, /记得跑测试/);
  assert.match(text, /todo_complete/);
});

test("a file with unknown or broken entries is normalised, never trusted", () => {
  const state = normalizeTodosState({
    version: 1,
    revision: 4,
    todos: [
      { id: "aaaaaaaa", title: "ok", project: "/p", status: "open", createdAt: 1, updatedAt: 1 },
      { id: "bad", title: "drop me", project: "/p" },
      { id: "bbbbbbbb", title: "", project: "/p" },
    ],
  });
  assert.equal(state.revision, 4);
  assert.deepEqual(state.todos.map((todo) => todo.id), ["aaaaaaaa"]);
  assert.equal(normalizeTodosState("nope"), null);
});
