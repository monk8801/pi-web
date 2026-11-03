import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { todoMenuItems, todoProjectChoices } = await jiti.import("./todo-menu.ts");

const commands = (display) => todoMenuItems(display).map((entry) => entry.command);

test("an open to-do offers a run, closing it by hand, editing, moving and deleting", () => {
  assert.deepEqual(commands("open"), ["run", "done", "edit", "move", "delete"]);
  assert.deepEqual(todoMenuItems("open").map((entry) => entry.disabled), [false, false, false, false, false]);
});

test("a waiting to-do and a running one can both be closed by hand; a live run is not started twice", () => {
  assert.deepEqual(commands("confirm"), ["run", "done", "edit", "move", "delete"]);
  const running = todoMenuItems("running");
  assert.deepEqual(running.map((entry) => entry.command), ["run", "done", "edit", "move", "delete"]);
  assert.equal(running[0].disabled, true, "a live run is not started twice");
  assert.equal(running[1].disabled, false, "marking it done by hand stays available");
});

test("a done to-do is a record: reopen or delete, never edit, move or run", () => {
  assert.deepEqual(commands("done"), ["reopen", "delete"]);
});

test("the move list is the sidebar's projects, deduplicated, the current one marked", () => {
  const choices = todoProjectChoices([
    { root: "/work/app" },
    { root: "/work/app" },
    { root: "/work/other", alias: "Pi Web" },
  ], "/work/app");
  assert.deepEqual(choices.map((choice) => choice.root), ["/work/app", "/work/other"]);
  assert.deepEqual(choices.map((choice) => choice.current), [true, false]);
  assert.deepEqual(choices.map((choice) => choice.label), ["app", "Pi Web"]);
});

test("a Windows project is named by its last segment", () => {
  const choices = todoProjectChoices([{ root: "C:\\work\\win-app" }], "/elsewhere");
  assert.equal(choices[0].label, "win-app");
});

test("no projects, no choices: the panel says so rather than offering an empty list", () => {
  assert.deepEqual(todoProjectChoices([], "/work/app"), []);
});
