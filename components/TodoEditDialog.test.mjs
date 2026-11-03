import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { todoEditFields } = await jiti.import("./TodoEditDialog.tsx");
const source = await readFile(new URL("./TodoEditDialog.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/sidebar.css", import.meta.url), "utf8");

test("a blank title cannot be saved; a title is trimmed", () => {
  assert.equal(todoEditFields("   ", "note"), null);
  assert.deepEqual(todoEditFields("  写文档  ", ""), { title: "写文档", note: null });
});

test("an emptied note clears the field instead of storing blank text", () => {
  assert.deepEqual(todoEditFields("T", "   "), { title: "T", note: null });
  assert.deepEqual(todoEditFields("T", "  两行\n备注  "), { title: "T", note: "两行\n备注" });
});

test("nothing but Save, Cancel and Escape dismisses it", () => {
  // No click-to-dismiss on the backdrop: a long note must not go with a stray
  // click. Escape is registered through the stacked-dialog helper.
  const backdropStart = source.indexOf('className="todo-edit-backdrop"');
  const backdropTag = source.slice(backdropStart, source.indexOf(">", backdropStart));
  assert.doesNotMatch(backdropTag, /onClick/, "the backdrop must not close the dialog");
  assert.match(source, /openStackedDialog\(document, dialogRef\.current/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
});

test("the note has the room a long one needs", () => {
  const rule = css.slice(css.indexOf(".todo-edit-note"), css.indexOf(".todo-edit-buttons"));
  assert.match(rule, /min-height: 40vh/);
  assert.match(rule, /resize: vertical/);
  const dialog = css.slice(css.indexOf(".todo-edit-dialog"), css.indexOf(".todo-edit-heading"));
  assert.match(dialog, /width: 620px/);
  // Only the body scrolls, so Save and Cancel stay on screen.
  assert.match(css.slice(css.indexOf(".todo-edit-dialog {"), css.indexOf(".todo-edit-heading")), /overflow: hidden/);
  assert.match(css.slice(css.indexOf(".todo-edit-body"), css.indexOf(".todo-edit-field {")), /overflow: auto/);
});
