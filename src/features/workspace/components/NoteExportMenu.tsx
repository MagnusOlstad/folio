import { useEffect, useId, useRef, useState } from "react";
import type { ComponentProps, KeyboardEvent } from "react";
import type { ViewerDocument } from "../../../domain/types.ts";
import type { NoteExportFormat } from "../model/note-export.ts";
import { TranslatedExportDialog } from "./TranslatedExportDialog.tsx";

type NoteExportMenuProps = {
  title: string;
  exporting: boolean;
  disabled?: boolean;
  onExport: (format: NoteExportFormat) => void;
  /** Present only for filed notes; `available` mirrors the translation settings. */
  translate?: {
    document: ViewerDocument;
    available: boolean;
    onDeliver: ComponentProps<typeof TranslatedExportDialog>["onDeliver"];
  };
};

export function NoteExportMenu({
  title,
  exporting,
  disabled = false,
  onExport,
  translate,
}: NoteExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [translateOpen, setTranslateOpen] = useState(false);
  const menuId = useId();
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

  function choose(format: NoteExportFormat) {
    setOpen(false);
    onExport(format);
  }

  function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"),
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      items[(index + direction + items.length) % items.length]?.focus();
    }
  }

  return (
    <div className="note-export-menu" ref={rootRef}>
      <button
        type="button"
        className="note-export-trigger"
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={exporting || disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
          window.requestAnimationFrame(() =>
            rootRef.current
              ?.querySelector<HTMLButtonElement>("[role=menuitem]")
              ?.focus(),
          );
        }}
      >
        {exporting ? "Exporting…" : "Export"}
      </button>
      {open ? (
        <div
          className="note-export-options"
          id={menuId}
          role="menu"
          aria-label={`Export ${title}`}
          onKeyDown={moveMenuFocus}
        >
          <button type="button" role="menuitem" onClick={() => choose("markdown")}>
            Markdown
          </button>
          <button type="button" role="menuitem" onClick={() => choose("pdf")}>
            PDF
          </button>
          {translate ? (
            <>
              <div className="note-export-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                disabled={!translate.available}
                title={translate.available ? undefined : "Install a generation model in Settings to translate notes."}
                onClick={() => {
                  setOpen(false);
                  setTranslateOpen(true);
                }}
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
