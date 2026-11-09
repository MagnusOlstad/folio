// Note variables: `key:: value` definition lines and `{{key}}` references, scoped to one note.
// Resolution is a view over the stored Markdown and never rewrites it. Keep in sync with
// server/core/note-variables.js (both are exercised by test/fixtures/note-variable-cases.json).
const DEFINITION = /^[ \t]*([A-Za-z][A-Za-z0-9_-]{0,63})::[ \t]+(\S.*?)[ \t]*$/;
const REFERENCE = /\{\{[ \t]*([A-Za-z][A-Za-z0-9_-]{0,63})[ \t]*\}\}/g;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

export type NoteVariableDefinition = {
  /** Lower-cased key. */
  key: string;
  /** Key as written. */
  name: string;
  value: string;
  /** Zero-based line index. */
  line: number;
  /** Offsets of the whole definition line, excluding the line break. */
  from: number;
  to: number;
};

export type NoteVariableReference = {
  key: string;
  name: string;
  from: number;
  to: number;
};

export type ResolvedNoteVariableReference = NoteVariableReference & {
  value: string | undefined;
};

export type NoteVariableScan = {
  definitions: NoteVariableDefinition[];
  references: NoteVariableReference[];
  /** Lower-cased key to value; the first definition wins. */
  variables: Map<string, string>;
};

type Line = { text: string; from: number; to: number };

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let position = 0;
  for (;;) {
    const newline = text.indexOf("\n", position);
    const end = newline === -1 ? text.length : newline;
    const to = end > position && text[end - 1] === "\r" ? end - 1 : end;
    lines.push({ text: text.slice(position, to), from: position, to });
    if (newline === -1) return lines;
    position = newline + 1;
  }
}

function frontmatterEnd(lines: Line[]) {
  if (!lines.length || !/^---[ \t]*$/.test(lines[0].text)) return -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[index].text)) return index;
  }
  return -1;
}

function inlineCodeRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const opener = /`+/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(line))) {
    const size = match[0].length;
    const closer = new RegExp(`(?<!\`)\`{${size}}(?!\`)`, "g");
    closer.lastIndex = opener.lastIndex;
    const end = closer.exec(line);
    if (!end) continue;
    ranges.push([match.index, end.index + size]);
    opener.lastIndex = end.index + size;
  }
  return ranges;
}

/** Finds definitions and references. Offsets index into the original string. */
export function scanNoteVariables(markdown: string): NoteVariableScan {
  const definitions: NoteVariableDefinition[] = [];
  const references: NoteVariableReference[] = [];
  const variables = new Map<string, string>();
  if (!markdown.includes("::") && !markdown.includes("{{"))
    return { definitions, references, variables };
  const lines = splitLines(markdown);
  const frontmatter = frontmatterEnd(lines);
  let fence: string | null = null;
  lines.forEach((line, index) => {
    if (index <= frontmatter) return;
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line.text)?.[1];
      if (closing && closing[0] === fence[0] && closing.length >= fence.length)
        fence = null;
      return;
    }
    const marker = FENCE_OPEN.exec(line.text)?.[1];
    if (marker) {
      fence = marker;
      return;
    }
    const definition = DEFINITION.exec(line.text);
    if (definition) {
      const key = definition[1].toLowerCase();
      definitions.push({
        key,
        name: definition[1],
        value: definition[2],
        line: index,
        from: line.from,
        to: line.to,
      });
      if (!variables.has(key)) variables.set(key, definition[2]);
      return;
    }
    if (!line.text.includes("{{")) return;
    const code = inlineCodeRanges(line.text);
    for (const match of line.text.matchAll(REFERENCE)) {
      const start = match.index;
      if (code.some(([from, to]) => start < to && start + match[0].length > from))
        continue;
      references.push({
        key: match[1].toLowerCase(),
        name: match[1],
        from: line.from + start,
        to: line.from + start + match[0].length,
      });
    }
  });
  return { definitions, references, variables };
}

export function parseNoteVariables(markdown: string): Map<string, string> {
  return scanNoteVariables(markdown).variables;
}

export function findVariableReferences(
  markdown: string,
): ResolvedNoteVariableReference[] {
  const { references, variables } = scanNoteVariables(markdown);
  return references.map((reference) => ({
    ...reference,
    value: variables.get(reference.key),
  }));
}

export type ResolveNoteVariablesOptions = {
  /** `display` rewrites `key:: value` lines as `key: value`. Default `keep`. */
  definitions?: "keep" | "display";
};

/** Substitutes defined references; undefined ones stay as written. */
export function resolveNoteVariables(
  markdown: string,
  options: ResolveNoteVariablesOptions = {},
): string {
  const { definitions, references, variables } = scanNoteVariables(markdown);
  const edits: Array<{ from: number; to: number; text: string }> = [];
  for (const reference of references) {
    const value = variables.get(reference.key);
    if (value !== undefined)
      edits.push({ from: reference.from, to: reference.to, text: value });
  }
  if (options.definitions === "display") {
    for (const definition of definitions)
      edits.push({
        from: definition.from,
        to: definition.to,
        text: `${definition.name}: ${definition.value}`,
      });
  }
  if (!edits.length) return markdown;
  edits.sort((a, b) => a.from - b.from);
  let result = "";
  let cursor = 0;
  for (const edit of edits) {
    result += markdown.slice(cursor, edit.from) + edit.text;
    cursor = edit.to;
  }
  return result + markdown.slice(cursor);
}

/** Resolved text for reading, preview and export: references replaced, definitions in display form. */
export function resolveNoteVariablesForDisplay(markdown: string): string {
  return resolveNoteVariables(markdown, { definitions: "display" });
}
