import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorView, Panel, ViewUpdate } from "@codemirror/view";

function matchSummary(view: EditorView) {
  const query = getSearchQuery(view.state);
  if (!query.valid || !query.search) return "0 results";
  const matches: Array<{ from: number; to: number }> = [];
  const cursor = query.getCursor(view.state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    matches.push(next.value);
  }
  const selection = view.state.selection.main;
  const current = matches.findIndex(
    (match) => match.from === selection.from && match.to === selection.to,
  );
  return current === -1
    ? `${matches.length} result${matches.length === 1 ? "" : "s"}`
    : `${current + 1} of ${matches.length} result${matches.length === 1 ? "" : "s"}`;
}

export function createNoteSearchPanel(view: EditorView): Panel {
  const dom = document.createElement("form");
  dom.className = "cm-search cm-note-search";
  dom.setAttribute("role", "search");
  dom.addEventListener("submit", (event) => {
    event.preventDefault();
    findNext(view);
  });

  const input = document.createElement("input");
  input.type = "search";
  input.className = "cm-textfield";
  input.name = "search";
  input.placeholder = "Find in note";
  input.setAttribute("aria-label", "Find in note");
  input.setAttribute("main-field", "true");
  input.value = getSearchQuery(view.state).search;
  const summary = document.createElement("output");
  summary.className = "cm-note-search-count";
  summary.setAttribute("aria-live", "polite");

  const button = (label: string, title: string, run: () => void) => {
    const control = document.createElement("button");
    control.type = "button";
    control.className = "cm-button";
    control.textContent = label;
    control.title = title;
    control.setAttribute("aria-label", title);
    control.addEventListener("click", run);
    return control;
  };

  const refresh = () => {
    summary.textContent = matchSummary(view);
  };
  input.addEventListener("input", () => {
    const previous = getSearchQuery(view.state);
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: input.value,
          caseSensitive: previous.caseSensitive,
          literal: previous.literal,
          regexp: previous.regexp,
          wholeWord: previous.wholeWord,
        }),
      ),
    });
    refresh();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(view);
      return;
    }
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      findPrevious(view);
    }
  });

  const closeButton = button("×", "Close Find", () => closeSearchPanel(view));
  closeButton.classList.add("cm-note-search-close");

  dom.append(
    input,
    summary,
    button("↑", "Previous match", () => findPrevious(view)),
    button("↓", "Next match", () => findNext(view)),
    closeButton,
  );
  refresh();

  return {
    dom,
    top: true,
    mount() {
      input.focus();
      input.select();
    },
    update(update: ViewUpdate) {
      const query = getSearchQuery(update.state);
      if (input.value !== query.search) input.value = query.search;
      refresh();
    },
  };
}
