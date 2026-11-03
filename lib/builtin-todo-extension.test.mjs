import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { createTodoCompleteExtension, TODO_COMPLETE_TOOL_NAME } = await jiti.import("./builtin-todo-extension.ts");
const { readTodos, resetTodosCacheForTests, updateTodos } = await jiti.import("./todos.ts");

const dir = await mkdtemp(join(tmpdir(), "pi-web-todo-tool-"));
after(async () => {
  resetTodosCacheForTests();
  await rm(dir, { recursive: true, force: true });
});

const path = join(dir, "pi-web-todos.json");

/** The bit of ExtensionAPI the extension uses. */
function fakePi() {
  const tools = [];
  return { tools, registerTool: (tool) => tools.push(tool) };
}

/** A tool call, as pi makes it. */
async function call(todoId) {
  const pi = fakePi();
  createTodoCompleteExtension({ todoId, path }).factory(pi);
  assert.equal(pi.tools.length, 1);
  return pi.tools[0].execute("call-1", {}, undefined, undefined, undefined);
}

test("it registers one tool, under the name the prompt asks for, taking no arguments", async () => {
  const pi = fakePi();
  createTodoCompleteExtension({ todoId: "aaaaaaaa", path }).factory(pi);
  assert.equal(pi.tools[0].name, TODO_COMPLETE_TOOL_NAME);
  assert.equal(pi.tools[0].name, "todo_complete");
  assert.deepEqual(pi.tools[0].parameters.properties ?? {}, {});
});

test("calling it marks that todo done by the agent, and only that one", async () => {
  resetTodosCacheForTests();
  const first = await updateTodos({ action: "add", title: "写测试", project: "/p" }, { path });
  const second = await updateTodos({ action: "add", title: "另一件", project: "/p" }, { path });
  const result = await call(first.todos[0].id);
  assert.equal(result.isError, undefined);
  assert.match(JSON.stringify(result.content), /写测试/);
  const state = readTodos(path);
  assert.equal(state.todos.find((todo) => todo.id === first.todos[0].id).status, "done");
  assert.equal(state.todos.find((todo) => todo.id === first.todos[0].id).doneBy, "agent");
  assert.equal(state.todos.find((todo) => todo.id === second.todos[1].id).status, "open");
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.equal(onDisk.todos.find((todo) => todo.id === first.todos[0].id).doneBy, "agent");
});

test("a second call is answered, not treated as an error", async () => {
  const first = readTodos(path).todos.find((todo) => todo.status === "done");
  const result = await call(first.id);
  assert.equal(result.isError, undefined);
  assert.match(JSON.stringify(result.content), /already done/);
});

test("a todo deleted while the run went on is reported, not thrown", async () => {
  const result = await call("ffffffff");
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /No such todo/);
});
