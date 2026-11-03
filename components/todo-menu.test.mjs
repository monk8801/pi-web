import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { todoMenuItems, todoProjectChoices } = await jiti.import("./todo-menu.ts");

const commands = (display) => todoMenuItems(display).map((entry) => entry.command);

test("an open to-do offers a run, moving it and deleting it — never a confirmation", () => {
  assert.deepEqual(commands("open"), ["run", "move", "delete"]);
  assert.deepEqual(todoMenuItems("open").map((entry) => entry.disabled), [false, false, false]);
});

test("a waiting to-do also offers marking it done, a running one cannot be run again", () => {
  assert.deepEqual(commands("confirm"), ["run", "done", "move", "delete"]);
  const running = todoMenuItems("running");
  assert.deepEqual(running.map((entry) => entry.command), ["run", "move", "delete"]);
  assert.equal(running[0].disabled, true, "a live run is not started twice");
});

test("a done to-do offers reopening, moving and deleting, and no run", () => {
  assert.deepEqual(commands("done"), ["reopen", "move", "delete"]);
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
