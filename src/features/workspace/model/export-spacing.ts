type Position = { start?: { line?: number }; end?: { line?: number } };

type SpacingNode = {
  type: string;
  position?: Position;
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>;
};

type SpacingRoot = { children?: SpacingNode[] };

export const EXPORT_LINE_HEIGHT_EM = 1.45;

/** Number of blank lines beyond the first one that separate two blocks. */
export function extraBlankLines(previous: SpacingNode, next: SpacingNode) {
  const end = previous.position?.end?.line;
  const start = next.position?.start?.line;
  if (typeof end !== "number" || typeof start !== "number") return 0;
  return Math.max(0, start - end - 1 - 1);
}

/**
 * Markdown collapses runs of blank lines. This remark plugin keeps every blank
 * line beyond the first as vertical space (padding, so margins can't swallow it).
 */
export function remarkPreserveBlankLines() {
  return (tree: SpacingRoot) => {
    const children = tree.children ?? [];
    for (let index = 1; index < children.length; index += 1) {
      const extra = extraBlankLines(children[index - 1], children[index]);
      if (extra <= 0) continue;
      const node = children[index];
      const data = node.data ?? {};
      const properties = data.hProperties ?? {};
      const existing = typeof properties.style === "string" ? `${properties.style};` : "";
      node.data = {
        ...data,
        hProperties: {
          ...properties,
          style: `${existing}padding-top:${(extra * EXPORT_LINE_HEIGHT_EM).toFixed(2)}em`,
        },
      };
    }
  };
}
