import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-todos-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { GET, POST } = await jiti.import("./route.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

const path = () => join(testAgentDir, "pi-web-todos.json");

function post(body, contentType = "application/json") {
  return new Request("http://localhost/api/todos", {
    method: "POST",
    headers: { "Content-Type": contentType, Host: "localhost" },
    body: JSON.stringify(body),
  });
}

test("GET starts empty, without caching", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.todos, []);
  assert.equal(body.revision, 0);
});

test("add, update, complete and reopen round-trip through GET", async () => {
  const added = await POST(post({ action: "add", title: "写测试", project: "/work/app" }));
  assert.equal(added.status, 200);
  const afterAdd = await added.json();
  assert.equal(afterAdd.todos.length, 1);
  assert.equal(afterAdd.todos[0].title, "写测试");
  const id = afterAdd.todos[0].id;

  const renamed = await (await POST(post({ action: "update", id, title: "改过的标题" }))).json();
  assert.equal(renamed.todos.find((todo) => todo.id === id).title, "改过的标题");
  assert.ok(renamed.revision > afterAdd.revision);

  const completed = await (await POST(post({ action: "complete", id }))).json();
  assert.equal(completed.todos.find((todo) => todo.id === id).status, "done");
  assert.equal(completed.todos.find((todo) => todo.id === id).doneBy, "user");

  const reopened = await (await POST(post({ action: "reopen", id }))).json();
  assert.equal(reopened.todos.find((todo) => todo.id === id).status, "open");
  assert.equal(reopened.todos.find((todo) => todo.id === id).doneAt, undefined);

  const read = await (await GET()).json();
  assert.equal(read.revision, reopened.revision);
  assert.ok(read.todos.some((todo) => todo.id === id));
});

test("a note can be added and removed", async () => {
  const added = await (await POST(post({ action: "add", title: "T", project: "/p" }))).json();
  const id = added.todos.at(-1).id;
  const noted = await (await POST(post({ action: "update", id, note: "备注" }))).json();
  assert.equal(noted.todos.find((todo) => todo.id === id).note, "备注");
  const cleared = await (await POST(post({ action: "update", id, note: null }))).json();
  assert.equal(cleared.todos.find((todo) => todo.id === id).note, undefined);
  const onDisk = JSON.parse(await readFile(path(), "utf8"));
  assert.equal(onDisk.todos.find((todo) => todo.id === id).note, undefined);
});

test("a bad body, a wrong content type or a bad action are refused with a reason", async () => {
  assert.equal((await POST(post({ action: "add", title: "x", project: "/p" }, "text/plain"))).status, 415);
  const badAction = await POST(post({ action: "nope" }));
  assert.equal(badAction.status, 400);
  assert.equal((await badAction.json()).reason, "invalid-request");
  assert.equal((await POST(post({ action: "add", title: "  ", project: "/p" }))).status, 400);
  assert.equal((await POST(new Request("http://localhost/api/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: "{not json",
  }))).status, 400);
});

test("an unknown id answers 404 rather than a silent success", async () => {
  const missing = await POST(post({ action: "complete", id: "ffffffff" }));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).reason, "not-found");
  const deleted = await POST(post({ action: "delete", id: "ffffffff" }));
  assert.equal(deleted.status, 404);
});

test("a session id cannot be set from a request body", async () => {
  const added = await (await POST(post({ action: "add", title: "T", project: "/p" }))).json();
  const id = added.todos.at(-1).id;
  const attach = await POST(post({ action: "attach", id, sessionId: "s-1" }));
  assert.equal(attach.status, 400);
  const read = await (await GET()).json();
  assert.equal(read.todos.find((todo) => todo.id === id).sessionId, undefined);
});
