import { fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { LiveMarkdownEditor } from "../../src/features/workspace/components/LiveMarkdownEditor.tsx";
import { resolveBundleLink } from "../../src/lib/paths.ts";

function renderLink(value: string) {
  const onOpenLink = vi.fn();
  render(<LiveMarkdownEditor value={value} onChange={vi.fn()} onOpenLink={onOpenLink} ariaLabel="Link note" />);
  const editor = screen.getByLabelText("Link note");
  const view = EditorView.findFromDOM(editor);
  const position = vi.spyOn(view, "posAtCoords");
  const click = (offset: number) => {
    position.mockReturnValue(offset);
    fireEvent.mouseDown(editor, { clientX: 0, clientY: 0, metaKey: true });
  };
  return { editor, onOpenLink, click };
}

describe("live markdown links", () => {
  it.each([
    ["[wiki](https://en.wikipedia.org/wiki/Function_(mathematics))", "https://en.wikipedia.org/wiki/Function_(mathematics)"],
    ["[note](<notes/file name.md>)", "notes/file name.md"],
    ["[note](notes/foo\\(bar\\).md)", "notes/foo(bar).md"],
    ["[mail](mailto:me@example.com)", "mailto:me@example.com"],
    ["[web](https://example.com?a=1&amp;b=2)", "https://example.com?a=1&b=2"],
    ["[web](https://example.com?a=1\\&amp;b=2)", "https://example.com?a=1&amp;b=2"],
  ])("opens the parsed destination of %s", (value, href) => {
    const { editor, click, onOpenLink } = renderLink(value);
    expect(editor.querySelector(".cm-live-markdown-link")).toBeTruthy();
    click(2);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(href);
  });

  it("preserves bundle-relative navigation for angle destinations", () => {
    const { click, onOpenLink } = renderLink("[note](<../notes/file name.md>)");
    click(2);
    expect(resolveBundleLink("/projects/current.md", onOpenLink.mock.calls[0][0])).toBe("/notes/file name.md");
  });

  it.each([
    "[label][ref]\n\n[ref]: notes/example.md",
    "[ref][]\n\n[ref]: notes/example.md",
    "[ref]\n\n[ref]: notes/example.md",
    "[label][ReF]\n\n[ref]: notes/example.md",
  ])("resolves reference links in %s", (value) => {
    const { click, onOpenLink } = renderLink(value);
    click(2);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("notes/example.md");
  });

  it.each([
    "`[code](https://example.com)`",
    "```\n[code](https://example.com)\n```",
    "~~~\n[code](https://example.com)\n~~~",
    "    [code](https://example.com)",
    "![code](https://example.com/image.png)",
  ])("does not turn code or image labels into links in %s", (value) => {
    const { editor, click, onOpenLink } = renderLink(value);
    expect(editor.querySelector(".cm-live-markdown-link")).toBeNull();
    click(value.indexOf("code") + 1);
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("keeps an escaped link label literal", () => {
    const { editor, click, onOpenLink } = renderLink("\\[literal](https://example.com)");
    expect(editor).toHaveTextContent("[literal](https://example.com)");
    click(4);
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it.each([
    "javascript:alert%281%29",
    "data:text/html,test",
    "vbscript:msgbox%281%29",
    "jav&#x61;script:alert%281%29",
  ])("does not navigate to unsafe destination %s", (href) => {
    const { editor, click, onOpenLink } = renderLink(`[run](${href})`);
    expect(editor.querySelector(".cm-live-markdown-link")).toBeNull();
    click(2);
    expect(onOpenLink).not.toHaveBeenCalled();
  });
});
