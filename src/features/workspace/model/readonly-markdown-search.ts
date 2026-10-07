import type { Element, Root, RootContent } from "hast";

type SearchOptions = { query: string; activeIndex: number };
type TextMatch = { start: number; end: number };

function textMatches(text: string, query: string): TextMatch[] {
  const lowercase = text.toLowerCase();
  if (!lowercase.includes(query)) return [];

  // Lowercasing can expand a code point (for example İ -> i + combining dot).
  // Map folded offsets back to the original text instead of slicing with them.
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of text) {
    const end = offset + character.length;
    for (let index = 0; index < character.toLowerCase().length; index++) {
      starts.push(offset);
      ends.push(end);
    }
    offset = end;
  }

  const matches: TextMatch[] = [];
  for (
    let match = lowercase.indexOf(query);
    match !== -1;
    match = lowercase.indexOf(query, match + query.length)
  ) {
    const start = starts[match];
    const end = ends[match + query.length - 1];
    if (!matches.length || start >= matches[matches.length - 1].end)
      matches.push({ start, end });
  }
  return matches;
}

export function readonlyMarkdownSearch({ query, activeIndex }: SearchOptions) {
  const lowercaseQuery = query.toLowerCase();
  return (tree: Root) => {
    if (!lowercaseQuery) return;
    let matchIndex = 0;
    function highlight(parent: Root | Element) {
      const children: RootContent[] = [];
      for (const child of parent.children) {
        if (child.type === "element") highlight(child);
        if (child.type !== "text") {
          children.push(child);
          continue;
        }
        let offset = 0;
        for (const match of textMatches(child.value, lowercaseQuery)) {
          if (match.start > offset)
            children.push({
              type: "text",
              value: child.value.slice(offset, match.start),
            });
          children.push({
            type: "element",
            tagName: "mark",
            properties: {
              className:
                matchIndex++ === activeIndex
                  ? ["readonly-search-match", "active"]
                  : ["readonly-search-match"],
            },
            children: [
              { type: "text", value: child.value.slice(match.start, match.end) },
            ],
          });
          offset = match.end;
        }
        if (offset < child.value.length)
          children.push({ type: "text", value: child.value.slice(offset) });
      }
      parent.children = children;
    }
    highlight(tree);
  };
}
