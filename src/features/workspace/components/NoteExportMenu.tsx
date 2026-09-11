import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { NoteExportFormat } from "../model/note-export.ts";

type NoteExportMenuProps = {
  title: string;
  exporting: boolean;
  onExport: (format: NoteExportFormat) => void;
};

export function NoteExportMenu({
  title,
  exporting,
  onExport,
}: NoteExportMenuProps) {
  const [open, setOpen] = useState(false);
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
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]"),
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
        disabled={exporting}
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
        </div>
      ) : null}
    </div>
  );
}
