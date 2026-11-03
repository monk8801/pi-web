import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { RunContextChip } = await jiti.import("./RunContextChip.tsx");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

const h = React.createElement;

function render(session) {
  return renderToStaticMarkup(h(I18nProvider, { locale: "en" }, h(RunContextChip, { session })));
}

const session = (overrides) => ({
  id: "s-1",
  path: "",
  cwd: "/work/app",
  name: undefined,
  created: "2026-11-02T00:00:00.000Z",
  modified: "2026-11-02T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "hi",
  ...overrides,
});

test("a session with a branch shows it, with the branch icon", () => {
  const html = render(session({ branch: "dev" }));
  assert.match(html, /class="run-context"/);
  assert.match(html, /class="run-context-branch">dev</);
  assert.match(html, /svg/);
  assert.match(html, /aria-label="Running on branch dev"/);
});

test("nothing without a branch: not a git folder, or a detached checkout", () => {
  // The catalog leaves `branch` unset for both, which is why neither shows.
  assert.equal(render(session({})), "");
  assert.equal(render(session({ isWorktree: true })), "");
  assert.equal(render(null), "");
});

test("a linked worktree is told apart by its icon's accent, not by a second label", () => {
  const main = render(session({ branch: "dev" }));
  const linked = render(session({ branch: "dev", isWorktree: true }));
  assert.doesNotMatch(main, /is-worktree/);
  assert.match(linked, /class="run-context is-worktree"/);
  assert.match(linked, /title="Linked git worktree · \/work\/app"/);
  assert.match(main, /title="Main git checkout · \/work\/app"/);
  // The accent is the icon's, never the text's.
  const worktreeIcon = css.slice(css.indexOf(".run-context.is-worktree .run-context-icon"), css.indexOf(".run-context-branch"));
  assert.match(worktreeIcon, /color: var\(--accent\)/);
});

test("a long branch is cut at its left, inside the composer's width", () => {
  const rule = css.slice(css.indexOf(".run-context-branch"), css.indexOf("}", css.indexOf(".run-context-branch")) + 1);
  assert.match(rule, /text-overflow: ellipsis/);
  assert.match(rule, /direction: rtl/);
  const chip = css.slice(css.indexOf(".run-context {"), css.indexOf(".run-context-icon {"));
  assert.match(chip, /max-width: 60%/);
  assert.match(chip, /color: var\(--text-dim\)/);
});
