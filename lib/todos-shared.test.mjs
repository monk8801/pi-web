import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const {
  MAX_TODO_NOTE_LENGTH,
  MAX_TODO_TITLE_LENGTH,
  MAX_TODOS,
  applyTodoRequest,
  emptyTodosState,
  normalizeTodosState,
  parseTodoRequest,
  todoDisplayStatus,
  todoStartPrompt,
} = await jiti.import("./todos-shared.ts");

const source = await readFile(new URL("./todos-shared.ts", import.meta.url), "utf8");

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
const parse = (body) => parseTodoRequest(body);
const request = (body) => {
  const result = parse(body);
  assert.equal(result.ok, true, result.error);
  return result.request;
};
/** What the next read of the file sees. */
const reread = (state) => normalizeTodosState(JSON.parse(JSON.stringify(state)));

test("is client-safe and never leaves the browser's copy with a Node import", () => {
  assert.doesNotMatch(source, /from "node:|from "(fs|path|os|crypto)"|require\(/);
  assert.doesNotMatch(source, /\(\?<[=!]/, "no RegExp lookbehind (Safari 16.2)");
});

test("a request is parsed into a known action or refused with a reason", () => {
  const added = parseTodoRequest({ action: "add", title: "  新待办  ", project: "/work/app" });
  assert.equal(added.ok, true);
  assert.equal(added.request.title, "新待办");
  assert.equal(parseTodoRequest({ action: "add", title: "   ", project: "/work/app" }).ok, false);
  assert.equal(parseTodoRequest({ action: "add", title: "x", project: "" }).ok, false);
  assert.equal(parseTodoRequest({ action: "nope" }).ok, false);
  assert.equal(parseTodoRequest({ action: "complete", id: "not-an-id" }).ok, false);
  assert.match(parseTodoRequest({ action: "complete" }).error, /id is required/);
  assert.match(parseTodoRequest({ action: "complete", id: "not-an-id" }).error, /eight hex characters/);
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

test("no request body can attach a session id", () => {
  const refused = parseTodoRequest({ action: "attach", id: "aaaaaaaa", sessionId: "s-1" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Unknown action/);
  // The server's own request, built by `lib/todos-start.ts`, still applies.
  const attached = applyTodoRequest(base(), { action: "attach", id: "aaaaaaaa", sessionId: "s-1" }, { now });
  assert.equal(attached.todos[0].sessionId, "s-1");
});

test("parse takes an update that only clears the note", () => {
  assert.deepEqual(request({ action: "update", id: "aaaaaaaa", note: null }), { action: "update", id: "aaaaaaaa", note: null });
  assert.deepEqual(request({ action: "update", id: "aaaaaaaa", note: "  备注  " }), { action: "update", id: "aaaaaaaa", note: "备注" });
  assert.deepEqual(request({ action: "update", id: "aaaaaaaa", note: "" }), { action: "update", id: "aaaaaaaa", note: null }, "an emptied note is a removal");
  assert.deepEqual(request({ action: "update", id: "aaaaaaaa", title: "T", extra: 1 }), { action: "update", id: "aaaaaaaa", title: "T" });
  assert.deepEqual(request({ action: "update", id: "aaaaaaaa", note: "  " }), { action: "update", id: "aaaaaaaa", note: null }, "spaces only is a removal too");
  assert.equal(parse({ action: "update", id: "aaaaaaaa" }).ok, false, "nothing to update");
  assert.equal(parse({ action: "update", id: "aaaaaaaa", title: "   " }).ok, false);
  assert.equal(parse({ action: "update", id: "zzzzzzzz", title: "T" }).ok, false);
});

test("an update that changes nothing is no change at all; a null note clears it", () => {
  const start = base();
  assert.equal(applyTodoRequest(start, { action: "update", id: "aaaaaaaa", title: "  写测试  ", project: "/work/app" }, { now }), start);
  assert.equal(applyTodoRequest(start, { action: "update", id: "aaaaaaaa", note: null }, { now }), start, "a note it does not have");
  assert.equal(applyTodoRequest(start, { action: "update", id: "aaaaaaaa", title: "写测试" }, { now: now + 1 }), start, "no timestamp either");

  const noted = applyTodoRequest(start, { action: "update", id: "aaaaaaaa", note: "备注" }, { now });
  assert.equal(noted.todos[0].note, "备注");
  assert.equal(applyTodoRequest(noted, { action: "update", id: "aaaaaaaa", note: "  备注  " }, { now }), noted, "trimmed before comparing");

  const cleared = applyTodoRequest(noted, { action: "update", id: "aaaaaaaa", note: null }, { now: now + 1 });
  assert.notEqual(cleared, noted);
  assert.deepEqual(cleared.todos[0], { ...base().todos[0], updatedAt: now + 1 });
  assert.equal("note" in cleared.todos[0], false, "the key goes, not an empty string");
  // An emptied textarea removes it as well, so the stored value cannot contradict the next read.
  assert.equal("note" in applyTodoRequest(noted, { action: "update", id: "aaaaaaaa", note: "   " }, { now }).todos[0], false);
  assert.equal(applyTodoRequest(cleared, { action: "update", id: "aaaaaaaa", note: null }, { now }), cleared);
  // Clearing a todo that only had a title and project leaves exactly that.
  assert.deepEqual(reread(cleared).todos, cleared.todos);
});

test("completing a done todo, and attaching the same session twice, change nothing", () => {
  const done = applyTodoRequest(base(), { action: "complete", id: "aaaaaaaa" }, { now });
  assert.equal(applyTodoRequest(done, { action: "complete", id: "aaaaaaaa" }, { now: now + 1 }), done);
  const attached = applyTodoRequest(base(), { action: "attach", id: "aaaaaaaa", sessionId: "s-1" }, { now });
  assert.equal(applyTodoRequest(attached, { action: "attach", id: "aaaaaaaa", sessionId: "s-1" }, { now: now + 1 }), attached);
  // A session id the file could not carry is no attach at all.
  const start = base();
  assert.equal(applyTodoRequest(start, { action: "attach", id: "aaaaaaaa", sessionId: "bad id" }, { now }), start);
  assert.equal(applyTodoRequest(start, { action: "attach", id: "aaaaaaaa", sessionId: "a".repeat(201) }, { now }), start);
});

test("a value over its limit is cut on the way in, so what is stored is what the next read keeps", () => {
  const added = request({ action: "add", title: "t".repeat(MAX_TODO_TITLE_LENGTH + 50), note: "n".repeat(MAX_TODO_NOTE_LENGTH + 50), project: "/p" });
  assert.equal(added.title.length, MAX_TODO_TITLE_LENGTH);
  assert.equal(added.note.length, MAX_TODO_NOTE_LENGTH);
  const state = applyTodoRequest(emptyTodosState(), added, { now, newId: () => "cafebabe" });
  assert.equal(state.todos[0].title.length, MAX_TODO_TITLE_LENGTH);
  assert.deepEqual(reread(state).todos, state.todos);

  const updated = applyTodoRequest(state, { action: "update", id: "cafebabe", title: "u".repeat(MAX_TODO_TITLE_LENGTH + 20) }, { now });
  assert.equal(updated.todos[0].title.length, MAX_TODO_TITLE_LENGTH);
  assert.deepEqual(reread(updated).todos, updated.todos);
  // A title already at the cap, sent again at the cap, is no change.
  assert.equal(applyTodoRequest(updated, { action: "update", id: "cafebabe", title: updated.todos[0].title }, { now }), updated);
});

test("a full list refuses the next add", () => {
  const full = {
    ...emptyTodosState(),
    todos: Array.from({ length: MAX_TODOS }, (_, index) => ({
      id: index.toString(16).padStart(8, "0"),
      title: `T${index}`,
      project: "/p",
      status: "open",
      createdAt: 1,
      updatedAt: 1,
    })),
  };
  assert.equal(applyTodoRequest(full, { action: "add", title: "X", project: "/p" }, { now, newId: () => "deadbeef" }), full);
  const oneLess = { ...full, todos: full.todos.slice(0, MAX_TODOS - 1) };
  assert.notEqual(applyTodoRequest(oneLess, { action: "add", title: "X", project: "/p" }, { now, newId: () => "deadbeef" }), oneLess);
});

test("the cap comes first: entries past MAX_TODOS are not read at all", () => {
  const overflow = {
    ...emptyTodosState(),
    todos: Array.from({ length: MAX_TODOS + 5 }, (_, index) => ({
      id: index.toString(16).padStart(8, "0"),
      title: `T${index}`,
      project: "/p",
      status: "open",
    })),
  };
  const state = reread(overflow);
  assert.equal(state.todos.length, MAX_TODOS);
  assert.equal(state.todos[MAX_TODOS - 1].title, `T${MAX_TODOS - 1}`);
});

test("a new id is retried while the state it is added to already has it", () => {
  const start = base(); // holds aaaaaaaa
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let calls = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues(bytes) {
        // The first draw repeats the todo already there; the second is fresh.
        bytes.fill(calls++ === 0 ? 0xaa : 0xbb);
        return bytes;
      },
    },
  });
  try {
    const added = applyTodoRequest(start, { action: "add", title: "T", project: "/p" }, { now });
    assert.deepEqual(added.todos.map((todo) => todo.id), ["aaaaaaaa", "bbbbbbbb"]);
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
  }
});

test("a document of another version is not read as this one", () => {
  assert.equal(normalizeTodosState({ version: 2, revision: 1, todos: [] }), null);
  assert.equal(normalizeTodosState({ version: "1", todos: [] }), null);
  assert.deepEqual(normalizeTodosState({ todos: [] }), emptyTodosState(), "an absent version reads as this one");
});

test("revision and timestamps must be whole, non-negative safe integers", () => {
  const state = normalizeTodosState({
    revision: 1e300,
    todos: [{ id: "aaaaaaaa", title: "ok", project: "/p", status: "open", createdAt: 1e300, updatedAt: 1.5, doneAt: -1 }],
  });
  assert.equal(state.revision, 0);
  assert.equal(state.todos[0].createdAt, 0);
  assert.equal(state.todos[0].updatedAt, 0, "falls back to createdAt");
  assert.equal(state.todos[0].doneAt, undefined, "an open todo keeps no completion time anyway");
  assert.equal(normalizeTodosState({ revision: 1.5, todos: [] }).revision, 0);
  assert.equal(normalizeTodosState({ revision: -1, todos: [] }).revision, 0);
  assert.equal(normalizeTodosState({ revision: 4, todos: [] }).revision, 4);
  assert.equal(normalizeTodosState({ revision: Number.MAX_SAFE_INTEGER, todos: [] }).revision, Number.MAX_SAFE_INTEGER);
});

test("a repeated id in the file is kept once, the first entry", () => {
  const state = normalizeTodosState({
    todos: [
      { id: "aaaaaaaa", title: "first", project: "/p", status: "open" },
      { id: "aaaaaaaa", title: "second", project: "/p", status: "open" },
      { id: "bbbbbbbb", title: "after", project: "/p", status: "open" },
    ],
  });
  assert.deepEqual(state.todos.map((todo) => todo.title), ["first", "after"]);
});

test("a session id the file could not carry is dropped, not kept", () => {
  const sessionOf = (sessionId) => normalizeTodosState({
    todos: [{ id: "aaaaaaaa", title: "t", project: "/p", status: "open", sessionId }],
  }).todos[0].sessionId;
  assert.equal(sessionOf("a-1"), "a-1");
  assert.equal(sessionOf("a".repeat(200)), "a".repeat(200));
  for (const value of ["a".repeat(201), "-bad", "bad/slash", "", "  ", "a b", 7]) {
    assert.equal(sessionOf(value), undefined, JSON.stringify(value)?.slice(0, 12));
  }
});
