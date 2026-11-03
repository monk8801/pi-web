import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { getTodosPath, getTodosRevision, readTodos, resetTodosCacheForTests, TodosLockedError, updateTodos } =
  await jiti.import("./todos.ts");
const { MAX_TODOS_FILE_BYTES } = await jiti.import("./todos-shared.ts");

after(() => {
  resetTodosCacheForTests();
});

/** A temp dir of its own per test, so nothing depends on the order tests run in. */
async function fixture(t) {
  resetTodosCacheForTests();
  const dir = await mkdtemp(join(tmpdir(), "pi-web-todos-"));
  t.after(async () => {
    resetTodosCacheForTests();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, path: join(dir, "pi-web-todos.json") };
}

const now = 1_700_000_000_000;

test("the path is the todos file beside pi's own files", () => {
  assert.equal(getTodosPath("/agent"), join("/agent", "pi-web-todos.json"));
  assert.ok(getTodosPath().endsWith("pi-web-todos.json"));
});

test("a missing file reads as an empty list and is not created", async (t) => {
  const { dir, path } = await fixture(t);
  const state = readTodos(path);
  assert.deepEqual(state.todos, []);
  assert.equal(state.revision, 0);
  assert.deepEqual(await readdir(dir), []);
});

test("add writes the file atomically with revision 1", async (t) => {
  const { path } = await fixture(t);
  const state = await updateTodos({ action: "add", title: "写测试", project: "/work/app" }, { path, now, newId: () => "aaaaaaaa" });
  assert.equal(state.revision, 1);
  assert.equal(state.todos.length, 1);
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.revision, 1);
  assert.deepEqual(onDisk.todos.map((todo) => todo.id), ["aaaaaaaa"]);
  assert.deepEqual(readTodos(path), state);
});

test("a second change bumps the revision; an unchanged request does not", async (t) => {
  const { path } = await fixture(t);
  await updateTodos({ action: "add", title: "T", project: "/p" }, { path, now, newId: () => "aaaaaaaa" });
  const done = await updateTodos({ action: "complete", id: "aaaaaaaa" }, { path, now: now + 1 });
  assert.equal(done.revision, 2);
  assert.equal(done.todos[0].status, "done");
  const again = await updateTodos({ action: "complete", id: "aaaaaaaa" }, { path, now: now + 2 });
  assert.equal(again.revision, 2);
});

test("a corrupt file is set aside and the write starts from empty", async (t) => {
  const { dir, path } = await fixture(t);
  await writeFile(path, "{not json", "utf8");
  const state = await updateTodos({ action: "add", title: "新", project: "/p" }, { path, now, newId: () => "bbbbbbbb" });
  assert.equal(state.todos.length, 1);
  const names = await readdir(dir);
  assert.ok(names.some((name) => name.startsWith("pi-web-todos.json.corrupt-")), `no backup in ${names.join(", ")}`);
});

test("a corrupt file is rewritten even when the request itself changes nothing", async (t) => {
  const { path } = await fixture(t);
  await writeFile(path, "{not json", "utf8");
  const state = await updateTodos({ action: "complete", id: "ffffffff" }, { path, now });
  assert.equal(state.revision, 1);
  assert.deepEqual(state.todos, []);
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(onDisk.revision, 1);
  assert.deepEqual(onDisk.todos, []);
});

test("unknown top-level fields survive a write, through a fresh read and through the cache", async (t) => {
  const { path } = await fixture(t);
  await writeFile(path, JSON.stringify({ version: 1, revision: 7, todos: [], future: { a: 1 } }), "utf8");
  await updateTodos({ action: "add", title: "T", project: "/p" }, { path, now, newId: () => "cccccccc" });
  let onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(onDisk.future, { a: 1 });
  assert.equal(onDisk.revision, 8);

  // The second write reads through the cache: the extras must not be lost there either.
  await updateTodos({ action: "add", title: "U", project: "/p" }, { path, now, newId: () => "dddddddd" });
  onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(onDisk.future, { a: 1 });
  assert.equal(onDisk.revision, 9);
});

test("a file another process locked refuses the write, and works once it is released", async (t) => {
  const { path } = await fixture(t);
  await writeFile(path, JSON.stringify({ version: 1, revision: 0, todos: [] }), "utf8");
  await mkdir(`${path}.lock`, { recursive: true });
  await assert.rejects(
    () => updateTodos({ action: "add", title: "T", project: "/p" }, { path, now, newId: () => "aaaaaaaa" }),
    (error) => error instanceof TodosLockedError,
  );
  await rm(`${path}.lock`, { recursive: true, force: true });
  const state = await updateTodos({ action: "add", title: "T", project: "/p" }, { path, now, newId: () => "aaaaaaaa" });
  assert.equal(state.todos.length, 1);
});

test("the revision is cheap to read: 0 without a file, the file's revision with one, null when unreadable", async (t) => {
  const { dir, path } = await fixture(t);
  assert.equal(getTodosRevision(path), 0);
  await writeFile(path, JSON.stringify({ version: 1, revision: 12, todos: [] }), "utf8");
  assert.equal(getTodosRevision(path), 12);
  await rm(path);
  await mkdir(path);
  t.after(() => rm(path, { recursive: true, force: true }));
  assert.equal(getTodosRevision(path), null);
  assert.deepEqual(readTodos(path).todos, []);
  assert.deepEqual(await readdir(dir).then((names) => names.filter((name) => name.startsWith("pi-web-todos.json.corrupt-"))), []);
});

test("an oversized file reads as empty and is set aside by the next write", async (t) => {
  const { dir, path } = await fixture(t);
  await writeFile(path, "x".repeat(MAX_TODOS_FILE_BYTES + 1), "utf8");
  assert.deepEqual(readTodos(path).todos, []);
  const state = await updateTodos({ action: "add", title: "T", project: "/p" }, { path, now, newId: () => "aaaaaaaa" });
  assert.equal(state.todos.length, 1);
  const names = await readdir(dir);
  assert.ok(names.some((name) => name.startsWith("pi-web-todos.json.corrupt-")), `no backup in ${names.join(", ")}`);
});

test("a complete records who did it", async (t) => {
  const { path } = await fixture(t);
  await updateTodos({ action: "add", title: "T", project: "/p" }, { path, now, newId: () => "aaaaaaaa" });
  const state = await updateTodos({ action: "complete", id: "aaaaaaaa" }, { path, now, doneBy: "agent" });
  assert.equal(state.todos[0].doneBy, "agent");
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(onDisk.todos[0].doneBy, "agent");
});

test("two writes issued together land in order", async (t) => {
  const { path } = await fixture(t);
  const first = updateTodos({ action: "add", title: "T", project: "/p" }, { path, now, newId: () => "aaaaaaaa" });
  const second = updateTodos({ action: "add", title: "U", project: "/p" }, { path, now, newId: () => "bbbbbbbb" });
  await Promise.all([first, second]);
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(onDisk.revision, 2);
  assert.deepEqual(onDisk.todos.map((todo) => todo.id), ["aaaaaaaa", "bbbbbbbb"]);
});

test("a removed file restarts from the revision that was already seen", async (t) => {
  const { path } = await fixture(t);
  await updateTodos({ action: "add", title: "T", project: "/p" }, { path, now, newId: () => "aaaaaaaa" });
  await updateTodos({ action: "add", title: "U", project: "/p" }, { path, now, newId: () => "bbbbbbbb" });
  assert.equal(readTodos(path).revision, 2);
  await rm(path);
  const state = await updateTodos({ action: "add", title: "V", project: "/p" }, { path, now, newId: () => "cccccccc" });
  assert.equal(state.revision, 3);
});
