import { useEffect, useId, useRef, useState } from "react";
import type { ComponentProps, KeyboardEvent } from "react";
import type { ViewerDocument } from "../../../domain/types.ts";
import type { NoteExportFormat } from "../model/note-export.ts";
import { TranslatedExportDialog } from "./TranslatedExportDialog.tsx";

type NoteMoreMenuProps = {
  title: string;
  exporting: boolean;
  disabled?: boolean;
  onExport: (format: NoteExportFormat) => void;
  /** Present only where Refile is offered (editable filed notes). */
  refile?: {
    onRefile: () => void;
    disabled: boolean;
    /** Tooltip explaining why Refile is unavailable right now. */
    reason?: string;
  };
  /** Present only for filed notes; `available` mirrors the translation settings. */
  translate?: {
    document: ViewerDocument;
    available: boolean;
    onDeliver: ComponentProps<typeof TranslatedExportDialog>["onDeliver"];
  };
};

const ENABLED_ITEMS = "[role=menuitem]:not(:disabled)";

export function NoteMoreMenu({
  title,
  exporting,
  disabled = false,
  onExport,
  refile,
  translate,
}: NoteMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const [translateOpen, setTranslateOpen] = useState(false);
  const menuId = useId();
  const exportLabelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeFromEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      window.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, [open]);

  function focusItem(which: "first" | "last") {
    window.requestAnimationFrame(() => {
      const items = rootRef.current?.querySelectorAll<HTMLButtonElement>(ENABLED_ITEMS);
      if (!items?.length) return;
      items[which === "first" ? 0 : items.length - 1].focus();
    });
  }

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(ENABLED_ITEMS));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      items[(index + direction + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    }
  }

  return (
    <div className="note-more-menu" ref={rootRef}>
      <button
        type="button"
        className="note-more-trigger"
        ref={triggerRef}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={exporting || disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
          focusItem(event.key === "ArrowDown" ? "first" : "last");
        }}
      >
        {exporting ? "Exporting…" : "More"}
      </button>
      {open ? (
        <div
          className="note-more-options"
          id={menuId}
          role="menu"
          aria-label={`More actions for ${title}`}
          onKeyDown={moveMenuFocus}
        >
          {refile ? (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={refile.disabled}
                title={refile.disabled ? refile.reason : undefined}
                onClick={() => choose(refile.onRefile)}
              >
                Refile…
              </button>
              <div className="note-more-separator" role="separator" />
            </>
          ) : null}
          <div role="group" aria-labelledby={exportLabelId} className="note-more-group">
            <span id={exportLabelId} className="note-more-label">Export</span>
            <button type="button" role="menuitem" onClick={() => choose(() => onExport("markdown"))}>
              Markdown
            </button>
            <button type="button" role="menuitem" onClick={() => choose(() => onExport("pdf"))}>
              PDF
            </button>
          </div>
          {translate ? (
            <>
              <div className="note-more-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                disabled={!translate.available}
                title={translate.available ? undefined : "Install a generation model in Settings to translate notes."}
                onClick={() => choose(() => setTranslateOpen(true))}
              >
                Translate…
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {translate && translateOpen ? (
        <TranslatedExportDialog
          document={translate.document}
          onDeliver={translate.onDeliver}
          onClose={() => {
            setTranslateOpen(false);
            window.requestAnimationFrame(() => triggerRef.current?.focus());
          }}
        />
      ) : null}
    </div>
  );
}
