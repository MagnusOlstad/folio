import type { EditorState, Range } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import { scanNoteVariables } from "../../../lib/note-variables.ts";

class VariableValueWidget extends WidgetType {
  readonly name: string;
  readonly value: string;

  constructor(name: string, value: string) {
    super();
    this.name = name;
    this.value = value;
  }

  eq(other: VariableValueWidget) {
    return other.name === this.name && other.value === this.value;
  }

  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-live-markdown-variable";
    element.title = `${this.name} = ${this.value}`;
    element.textContent = this.value;
    return element;
  }
}

/**
 * Note variables in the live editor: `{{key}}` shows its value until the
 * selection touches it, undefined references keep their raw text with a warning
 * style, and `key::` definition lines stay editable with a subtle key styling.
 */
export function addVariableDecorations(
  ranges: Array<Range<Decoration>>,
  state: EditorState,
  reveal: (from: number, to: number) => boolean,
) {
  const text = state.doc.toString();
  if (!text.includes("::") && !text.includes("{{")) return;
  const { definitions, references, variables } = scanNoteVariables(text);
  for (const definition of definitions) {
    const keyFrom = definition.from + text.slice(definition.from, definition.to).indexOf(definition.name);
    const keyTo = keyFrom + definition.name.length;
    ranges.push(
      Decoration.mark({ class: "cm-live-markdown-variable-key" }).range(keyFrom, keyTo),
      Decoration.mark({ class: "cm-live-markdown-variable-separator" }).range(keyTo, keyTo + 2),
    );
  }
  for (const reference of references) {
    const value = variables.get(reference.key);
    if (value === undefined) {
      ranges.push(
        Decoration.mark({
          class: "cm-live-markdown-variable-undefined",
          attributes: { title: `${reference.name} is not defined` },
        }).range(reference.from, reference.to),
      );
    } else if (!reveal(reference.from, reference.to)) {
      ranges.push(
        Decoration.replace({
          widget: new VariableValueWidget(reference.name, value),
        }).range(reference.from, reference.to),
      );
    }
  }
}
