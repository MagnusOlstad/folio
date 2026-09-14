import { useEffect, useRef } from "react";
import type { CommandPaletteState } from "../hooks/useCommandPalette.ts";

export function CommandPalette({ palette }: { palette: CommandPaletteState }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<CommandPaletteState>(palette);

  useEffect(() => {
    paletteRef.current = palette;
  });

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    inputRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      const state = paletteRef.current;
      if (event.key === "Escape") {
        event.preventDefault();
        state.closePalette();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.move(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        state.move(-1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        state.execute();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>(
      '.palette-row[data-selected="true"]',
    );
    selected?.scrollIntoView({ block: "nearest" });
  }, [palette.activeIndex, palette.rows]);

  const rowIndexes = new Map(
    palette.rows.map((row, index) => [row.command.id, index]),
  );

  return (
    <div
      className="palette-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) palette.closePalette();
      }}
    >
      <section
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          placeholder="Search notes and commands…"
          autoComplete="off"
          spellCheck={false}
          value={palette.query}
          onChange={(event) => palette.setQuery(event.target.value)}
          aria-label="Search notes and commands"
        />
        <div ref={listRef} className="palette-list">
          {palette.sections.map((section) => (
            <div className="palette-section" key={section.id}>
              <span className="palette-heading">{section.heading}</span>
              {section.commands.map((command) => {
                const index = rowIndexes.get(command.id);
                const selected = index === palette.activeIndex;
                return (
                  <button
                    type="button"
                    key={command.id}
                    className="palette-row"
                    data-selected={selected ? "true" : undefined}
                    onClick={() => index !== undefined && palette.execute(index)}
                  >
                    <span className="palette-row-text">
                      <strong>{command.label}</strong>
                      {command.description ? (
                        <small>{command.description}</small>
                      ) : null}
                    </span>
                    {command.hotkey ? (
                      <kbd className="palette-hotkey">{command.hotkey}</kbd>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
          {!palette.rows.length ? (
            <p className="palette-empty">No matching notes or commands</p>
          ) : null}
        </div>
        <footer className="palette-footer">↑↓ navigate · ↵ select · esc close</footer>
      </section>
    </div>
  );
}
