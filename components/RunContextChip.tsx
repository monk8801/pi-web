"use client";

// Which git branch the shown session runs on, under its composer.
//
// pi's own TUI prints `pwd (branch)` in its footer, and this is that fact in Pi
// Web's footer: the branch of the session's cwd, right under the input box, so
// "is this running on a worktree or on the main checkout?" is answered where the
// question is asked — while reading or typing in the chat. The sidebar says the
// same of every session row; this says it once for the one on screen.
//
// Data is the session catalog's (`SessionInfo.branch` / `isWorktree`, computed by
// the server), so it follows a session-list refresh: a branch switched in a
// terminal is not seen until then. That is the trade for costing no request, and
// the reason it stays out of the way: nothing here polls.
//
// Not a button and not a menu: it is a fact. A non-git folder shows nothing, and
// the catalog cannot tell a detached HEAD from "no repository" (both leave
// `branch` unset), so a detached checkout shows nothing either.

import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";
import { BranchIcon } from "./SidebarIcons";

interface Props {
  /** The session whose branch to show; a fresh composer has none, and shows none. */
  session: SessionInfo | null;
}

export function RunContextChip({ session }: Props) {
  const { t } = useI18n();
  const branch = session?.branch;
  if (!branch) return null;
  const cwd = session?.cwd;
  return (
    <div
      className={`run-context${session?.isWorktree ? " is-worktree" : ""}`}
      title={[
        session?.isWorktree ? t("runContext.worktree") : t("runContext.main"),
        cwd,
      ].filter(Boolean).join(" · ")}
      aria-label={t("runContext.label", { branch })}
    >
      <BranchIcon size={10} className="run-context-icon" />
      <span className="run-context-branch">{branch}</span>
    </div>
  );
}
