import { useEffect, useId, useRef } from "react";

type NoteDeleteConfirmationProps = {
  title: string;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function NoteDeleteConfirmation({
  title,
  deleting,
  onCancel,
  onConfirm,
}: NoteDeleteConfirmationProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || deleting) return;
      event.preventDefault();
      onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [deleting, onCancel]);

  return (
    <div className="filing-confirmation-layer">
      <aside
        className="filing-confirmation note-delete-confirmation"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header>
          <div>
            <h2 id={titleId}>Delete note</h2>
          </div>
          <span className="filing-status note-delete-status">Confirm</span>
        </header>
        <p id={descriptionId} className="note-delete-description">
          Delete “{title}”? The raw capture will be retained.
        </p>
        <div className="filing-actions">
          <span>Esc to cancel</span>
          <div>
            <button
              ref={cancelRef}
              className="filing-button filing-button-secondary"
              type="button"
              onClick={onCancel}
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              className="filing-button filing-button-danger"
              type="button"
              onClick={onConfirm}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete note"}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
