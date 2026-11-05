/** Pure GFM pipe-table parsing and inline-markdown tokenising for the live editor. */

export type TableAlign = "left" | "center" | "right" | null;

export type ParsedTable = {
  header: string[];
  align: TableAlign[];
  rows: string[][];
};

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del"; children: InlineNode[] }
  | { type: "link"; href: string; children: InlineNode[] };

/** Splits a table row on unescaped pipes, trimming optional outer pipes. */
export function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  const cells: string[] = [];
  let current = "";
  let ended = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && text[index + 1] === "|") {
      current += "\\|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
      ended = true;
    } else {
      current += char;
      ended = false;
    }
  }
  if (!ended || current.trim()) cells.push(current.trim());
  return cells;
}

export function parseAlignment(cell: string): TableAlign | undefined {
  const match = /^(:)?-+(:)?$/.exec(cell.trim());
  if (!match) return undefined;
  if (match[1] && match[2]) return "center";
  if (match[2]) return "right";
  if (match[1]) return "left";
  return null;
}

/** Parses table source; returns null when it is not a valid GFM table. */
export function parseTable(source: string): ParsedTable | null {
  const lines = source.split("\n").filter((line) => line.trim() !== "");
  if (lines.length < 2) return null;
  const header = splitTableRow(lines[0]);
  const delimiter = splitTableRow(lines[1]).map(parseAlignment);
  if (!header.length || delimiter.length !== header.length) return null;
  if (delimiter.some((value) => value === undefined)) return null;
  const align = delimiter as TableAlign[];
  const rows = lines.slice(2).map((line) => {
    const cells = splitTableRow(line);
    while (cells.length < header.length) cells.push("");
    return cells.slice(0, header.length);
  });
  return { header, align, rows };
}

export function safeHref(href: string) {
  const value = href.trim();
  return /^(?:https?:|mailto:)/i.test(value) || !/^[a-z][a-z\d+.-]*:/i.test(value) ? value : null;
}

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;

/** Tokenises the inline subset shown in table cells: emphasis, strike, code, links. */
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) nodes.push({ type: "text", text: buffer });
    buffer = "";
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length && ESCAPABLE.test(text[index + 1])) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      const run = /^`+/.exec(text.slice(index))![0];
      const close = text.indexOf(run, index + run.length);
      if (close > index + run.length) {
        flush();
        nodes.push({ type: "code", text: text.slice(index + run.length, close).replace(/\\\|/g, "|").trim() });
        index = close + run.length;
        continue;
      }
    }
    const delimiter = /^(\*\*|__|~~|\*|_)(?=\S)/.exec(text.slice(index))?.[1];
    if (delimiter) {
      const close = findClosing(text, delimiter, index + delimiter.length);
      if (close > index + delimiter.length) {
        flush();
        const type = delimiter === "~~" ? "del" : delimiter.length === 2 ? "strong" : "em";
        nodes.push({ type, children: parseInline(text.slice(index + delimiter.length, close)) });
        index = close + delimiter.length;
        continue;
      }
    }
    if (char === "[") {
      const link = /^\[((?:\\.|[^\]\\])*)\]\(\s*<?([^\s)>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(text.slice(index));
      const href = link ? safeHref(link[2]) : null;
      if (link && href) {
        flush();
        nodes.push({ type: "link", href, children: parseInline(link[1]) });
        index += link[0].length;
        continue;
      }
    }
    buffer += char;
    index += 1;
  }
  flush();
  return nodes;
}

function findClosing(text: string, delimiter: string, from: number) {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      if (close > index) index = close;
    } else if (text.startsWith(delimiter, index) && index > from && !/\s/.test(text[index - 1])) return index;
  }
  return -1;
}

/** Builds DOM for cell content; text is always set via text nodes. */
export function renderInline(nodes: InlineNode[], doc: Document = document): Node[] {
  return nodes.map((node) => {
    switch (node.type) {
      case "text":
        return doc.createTextNode(node.text);
      case "code": {
        const code = doc.createElement("code");
        code.textContent = node.text;
        return code;
      }
      case "link": {
        const anchor = doc.createElement("a");
        anchor.href = node.href;
        anchor.className = "cm-live-markdown-link";
        anchor.append(...renderInline(node.children, doc));
        return anchor;
      }
      default: {
        const element = doc.createElement(node.type === "strong" ? "strong" : node.type === "em" ? "em" : "del");
        element.append(...renderInline(node.children, doc));
        return element;
      }
    }
  });
}

export function renderTable(table: ParsedTable, doc: Document = document) {
  const element = doc.createElement("table");
  element.className = "cm-live-markdown-table-grid";
  const fill = (tag: "th" | "td", cells: string[]) => {
    const row = doc.createElement("tr");
    cells.forEach((cell, column) => {
      const node = doc.createElement(tag);
      const align = table.align[column];
      if (align) node.style.textAlign = align;
      node.append(...renderInline(parseInline(cell), doc));
      row.append(node);
    });
    return row;
  };
  const head = doc.createElement("thead");
  head.append(fill("th", table.header));
  const body = doc.createElement("tbody");
  for (const row of table.rows) body.append(fill("td", row));
  element.append(head, body);
  return element;
}
