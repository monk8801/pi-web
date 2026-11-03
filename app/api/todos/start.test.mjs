import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-todos-start-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { createStartTodo } = await jiti.import("@/lib/todos-start.ts");
const { readTodos, resetTodosCacheForTests, updateTodos } = await jiti.import("@/lib/todos.ts");

after(async () => {
  resetTodosCacheForTests();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

const project = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-todos-project-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test("a missing todo is refused 404 without starting anything", async () => {
  let started = 0;
  const startTodo = createStartTodo({
    exists: () => true,
    isRunning: () => false,
    startSession: async () => { started += 1; return { sessionId: "s-1" }; },
  });
  const result = await startTodo("ffffffff");
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(started, 0);
});

test("a project folder that is gone is refused before a session is created", async (t) => {
  const cwd = await project(t);
  const added = await updateTodos({ action: "add", title: "T", project: cwd });
  let started = 0;
  const startTodo = createStartTodo({
    exists: () => false,
    isRunning: () => false,
    startSession: async () => { started += 1; return { sessionId: "s-1" }; },
  });
  const result = await startTodo(added.todos[0].id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cwd-missing");
  assert.equal(started, 0);
});

test("starting sends the task, records the session id and asks for todo_complete", async (t) => {
  const cwd = await project(t);
  const added = await updateTodos({ action: "add", title: "写一个 README 小节", note: "记得跑测试", project: cwd });
  const id = added.todos.at(-1).id;
  const sent = [];
  const startTodo = createStartTodo({
    exists: () => true,
    isRunning: () => false,
    startSession: async (options) => { sent.push(options); return { sessionId: "s-new" }; },
  });
  const result = await startTodo(id);
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "s-new");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].cwd, cwd);
  assert.equal(sent[0].todoId, id);
  assert.match(sent[0].message, /写一个 README 小节/);
  assert.match(sent[0].message, /记得跑测试/);
  assert.match(sent[0].message, /todo_complete/);
  const stored = readTodos().todos.find((todo) => todo.id === id);
  assert.equal(stored.sessionId, "s-new");
  const onDisk = JSON.parse(await readFile(join(testAgentDir, "pi-web-todos.json"), "utf8"));
  assert.equal(onDisk.todos.find((todo) => todo.id === id).sessionId, "s-new");
});

test("a session that is still running is opened instead of started again", async (t) => {
  const cwd = await project(t);
  const added = await updateTodos({ action: "add", title: "T", project: cwd });
  const id = added.todos.at(-1).id;
  await updateTodos({ action: "attach", id, sessionId: "s-open" });
  let started = 0;
  const startTodo = createStartTodo({
    exists: () => true,
    isRunning: (sessionId) => sessionId === "s-open",
    startSession: async () => { started += 1; return { sessionId: "s-other" }; },
  });
  const result = await startTodo(id);
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "s-open");
  assert.equal(started, 0);
});

test("a session that already ended is replaced by a new run", async (t) => {
  const cwd = await project(t);
  const added = await updateTodos({ action: "add", title: "T", project: cwd });
  const id = added.todos.at(-1).id;
  await updateTodos({ action: "attach", id, sessionId: "s-old" });
  const startTodo = createStartTodo({
    exists: () => true,
    isRunning: () => false,
    startSession: async () => ({ sessionId: "s-second" }),
  });
  const result = await startTodo(id);
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "s-second");
  assert.equal(readTodos().todos.find((todo) => todo.id === id).sessionId, "s-second");
});
