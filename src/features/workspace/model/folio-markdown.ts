import type {} from "remark-parse";
import type { Processor } from "unified";

export function folioMarkdown(this: Processor) {
  const extensions = this.data("micromarkExtensions") ?? [];
  this.data("micromarkExtensions", [
    ...extensions,
    { disable: { null: ["setextUnderline"] } },
  ]);
}
