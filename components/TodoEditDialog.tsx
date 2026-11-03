"use client";

// Editing a to-do's title and note.
//
// It is a dialog of its own rather than a menu body: a note can be long, and a
// form that closes on the next click outside loses what was typed. Nothing here
// dismisses it but Save, Cancel and Escape — not a click on the backdrop.
//
// The shape is the project trust dialog's (`components/ProjectTrustDialog.tsx`):
// a backdrop that centres it, `openStackedDialog` for Escape and focus, and only
// the body scrolling so a long note never pushes the buttons off screen.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { openStackedDialog } from "@/lib/stacked-dialog";
import type { Todo } from "@/lib/todos-shared";

/** The change a save sends: a blank title saves nothing, an empty note clears it. */
export function todoEditFields(title: string, note: string): { title: string; note: string | null } | null {
  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) return null;
  const trimmedNote = note.trim();
  return { title: trimmedTitle, note: trimmedNote.length === 0 ? null : trimmedNote };
}

interface Props {
  todo: Todo;
  /** A write is in flight: Save is disabled and Escape ignored. */
  busy?: boolean;
  onSave(fields: { title: string; note: string | null }): void;
  onCancel(): void;
}

export function TodoEditDialog({ todo, busy = false, onSave, onCancel }: Props) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [title, setTitle] = useState(todo.title);
  const [note, setNote] = useState(todo.note ?? "");
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  // Escape closes it alone, above anything else that listens (a Settings panel,
  // an open menu), and focus returns to what opened it.
  useEffect(() => openStackedDialog(document, dialogRef.current, () => {
    if (!busyRef.current) cancelRef.current();
  }), []);

  const fields = todoEditFields(title, note);
  const save = () => {
    if (fields === null || busy) return;
    onSave(fields);
  };

  return createPortal(
    <div
      role="presentation"
      className="todo-edit-backdrop"
      // Deliberately no click-to-dismiss: a long note would go with a stray click.
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="todo-edit-title"
        tabIndex={-1}
        className="todo-edit-dialog"
      >
        <div id="todo-edit-title" className="todo-edit-heading">{t("todos.edit")}</div>
        <div className="todo-edit-body">
          <label className="todo-edit-field">
            <span className="todo-edit-label">{t("todos.editTitle")}</span>
            <input
              className="todo-edit-input"
              value={title}
              autoFocus
              aria-label={t("todos.editTitle")}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                save();
              }}
            />
          </label>
          <label className="todo-edit-field todo-edit-field-note">
            <span className="todo-edit-label">{t("todos.editNote")}</span>
            <textarea
              className="todo-edit-note"
              value={note}
              aria-label={t("todos.editNote")}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        </div>
        <div className="todo-edit-buttons">
          <button type="button" className="todo-edit-cancel" onClick={onCancel} disabled={busy}>
            {t("todos.cancel")}
          </button>
          <button
            type="button"
            className="todo-edit-save"
            onClick={save}
            disabled={busy || fields === null}
            title={fields === null ? t("todos.editTitleRequired") : undefined}
          >
            {t("todos.save")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
