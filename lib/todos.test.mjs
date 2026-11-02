import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { getTodosPath, readTodos, resetTodosCacheForTests, updateTodos } = await jiti.import("./todos.ts");

const dir = await mkdtemp(join(tmpdir(), "pi-web-todos-"));
after(async () => {
  resetTodosCacheForTests();
  await rm(dir, { recursive: true, force: true });
});

const path = () => join(dir, "pi-web-todos.json");
const now = 1_700_000_000_000;

test("the path is the todos file beside pi's own files", () => {
  assert.equal(getTodosPath("/agent"), join("/agent", "pi-web-todos.json"));
  assert.ok(getTodosPath().endsWith("pi-web-todos.json"));
});

test("a missing file reads as an empty list and is not created", async () => {
  const state = readTodos(path());
  assert.deepEqual(state.todos, []);
  assert.equal(state.revision, 0);
  assert.deepEqual(await readdir(dir), []);
});

test("add writes the file atomically with revision 1", async () => {
  const state = await updateTodos({ action: "add", title: "写测试", project: "/work/app" }, { path: path(), now, newId: () => "aaaaaaaa" });
  assert.equal(state.revision, 1);
  assert.equal(state.todos.length, 1);
  const onDisk = JSON.parse(await readFile(path(), "utf8"));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.revision, 1);
  assert.deepEqual(onDisk.todos.map((todo) => todo.id), ["aaaaaaaa"]);
  assert.deepEqual(readTodos(path()), state);
});

test("a second change bumps the revision; an unchanged request does not", async () => {
  const done = await updateTodos({ action: "complete", id: "aaaaaaaa" }, { path: path(), now: now + 1 });
  assert.equal(done.revision, 2);
  assert.equal(done.todos[0].status, "done");
  const again = await updateTodos({ action: "complete", id: "aaaaaaaa" }, { path: path(), now: now + 2 });
  assert.equal(again.revision, 2);
});

test("a corrupt file is set aside and the write starts from empty", async () => {
  await writeFile(path(), "{not json", "utf8");
  resetTodosCacheForTests();
  const state = await updateTodos({ action: "add", title: "新", project: "/p" }, { path: path(), now, newId: () => "bbbbbbbb" });
  assert.equal(state.todos.length, 1);
  const names = await readdir(dir);
  assert.ok(names.some((name) => name.startsWith("pi-web-todos.json.corrupt-")), `no backup in ${names.join(", ")}`);
});

test("unknown top-level fields survive a write", async () => {
  await writeFile(path(), JSON.stringify({ version: 1, revision: 7, todos: [], future: { a: 1 } }), "utf8");
  resetTodosCacheForTests();
  await updateTodos({ action: "add", title: "T", project: "/p" }, { path: path(), now, newId: () => "cccccccc" });
  const onDisk = JSON.parse(await readFile(path(), "utf8"));
  assert.deepEqual(onDisk.future, { a: 1 });
  assert.equal(onDisk.revision, 8);
});
