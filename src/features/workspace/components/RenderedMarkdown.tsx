import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { ViewerDocument } from "../../../domain/types.ts";
import { conceptUrl, resolveBundleLink } from "../../../lib/paths.ts";
import { sourcePosition } from "../../../lib/workspace.ts";

type RenderedMarkdownProps = {
  document: ViewerDocument;
  groupId: string;
  saving: boolean;
  onOpenDocument: (
    id: string,
    source?: "note" | "file",
    targetGroupId?: string,
  ) => Promise<void>;
  onToggleTask: (
    document: ViewerDocument,
    lineNumber: number,
    checked: boolean,
  ) => Promise<void>;
};

export function RenderedMarkdown({
  document,
  groupId,
  saving,
  onOpenDocument,
  onToggleTask,
}: RenderedMarkdownProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findResultRef = useRef<HTMLSpanElement>(null);
  const findScrollTopRef = useRef(0);
  const matchesRef = useRef<HTMLElement[]>([]);
  const activeMatchRef = useRef(0);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const openFind = () => {
      findScrollTopRef.current =
        content.closest<HTMLElement>("[data-document-scroll]")?.scrollTop ?? 0;
      setFindOpen(true);
    };
    content.addEventListener("folio-find", openFind);
    return () => content.removeEventListener("folio-find", openFind);
  }, []);

  useLayoutEffect(() => {
    if (!findOpen) return;
    const scroll = contentRef.current?.closest<HTMLElement>(
      "[data-document-scroll]",
    );
    findInputRef.current?.focus({ preventScroll: true });
    findInputRef.current?.select();
    if (scroll) scroll.scrollTop = findScrollTopRef.current;
  }, [findOpen]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    for (const mark of content.querySelectorAll("mark.readonly-search-match")) {
      const parent = mark.parentElement;
      mark.replaceWith(window.document.createTextNode(mark.textContent ?? ""));
      parent?.normalize();
    }
    matchesRef.current = [];
    activeMatchRef.current = 0;
    if (!findQuery) {
      updateActiveMatch(0);
      return;
    }

    const query = findQuery.toLocaleLowerCase();
    const textNodes: Text[] = [];
    const walker = window.document.createTreeWalker(
      content,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue?.toLocaleLowerCase().includes(query))
        textNodes.push(node as Text);
    }
    for (const node of textNodes) {
      const text = node.nodeValue ?? "";
      const lowercase = text.toLocaleLowerCase();
      const fragment = window.document.createDocumentFragment();
      let offset = 0;
      for (let match = lowercase.indexOf(query, offset); match !== -1; ) {
        fragment.append(text.slice(offset, match));
        const highlight = window.document.createElement("mark");
        highlight.className = "readonly-search-match";
        highlight.textContent = text.slice(match, match + findQuery.length);
        fragment.append(highlight);
        matchesRef.current.push(highlight);
        offset = match + findQuery.length;
        match = lowercase.indexOf(query, offset);
      }
      fragment.append(text.slice(offset));
      node.replaceWith(fragment);
    }
    updateActiveMatch(0);
  }, [document.content, findOpen, findQuery]);

  function updateActiveMatch(index: number) {
    const matches = matchesRef.current;
    for (const [matchIndex, match] of matches.entries())
      match.classList.toggle("active", matchIndex === index);
    const result = findResultRef.current;
    if (result)
      result.textContent = matches.length
        ? `${index + 1} of ${matches.length}`
        : findQuery
          ? "No matches"
          : "";
    matches[index]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function moveMatch(direction: 1 | -1) {
    const count = matchesRef.current.length;
    if (!count) return;
    activeMatchRef.current =
      (activeMatchRef.current + direction + count) % count;
    updateActiveMatch(activeMatchRef.current);
  }

  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const linkedFile = resolveBundleLink(document.id, href);
        return linkedFile ? (
          <a
            href={conceptUrl(linkedFile)}
            onClick={(event) => {
              event.preventDefault();
              void onOpenDocument(linkedFile, "file", groupId);
            }}
          >
            {children}
          </a>
        ) : (
          <a href={href}>{children}</a>
        );
      },
      p: ({ node, ...props }) => <p {...props} {...sourcePosition(node)} />,
      h1: ({ node, ...props }) => <h1 {...props} {...sourcePosition(node)} />,
      h2: ({ node, ...props }) => <h2 {...props} {...sourcePosition(node)} />,
      h3: ({ node, ...props }) => <h3 {...props} {...sourcePosition(node)} />,
      h4: ({ node, ...props }) => <h4 {...props} {...sourcePosition(node)} />,
      h5: ({ node, ...props }) => <h5 {...props} {...sourcePosition(node)} />,
      h6: ({ node, ...props }) => <h6 {...props} {...sourcePosition(node)} />,
      blockquote: ({ node, ...props }) => (
        <blockquote {...props} {...sourcePosition(node)} />
      ),
      pre: ({ node, ...props }) => <pre {...props} {...sourcePosition(node)} />,
      li: ({ node, ...props }) => <li {...props} {...sourcePosition(node)} />,
      table: ({ node, ...props }) => (
        <table {...props} {...sourcePosition(node)} />
      ),
      input: ({ node: _node, ...props }) => (
        <input
          {...props}
          disabled={props.type !== "checkbox" || !document.deletable || saving}
          onChange={(event) => {
            const lineNumber = Number(
              event.currentTarget.closest("li")?.dataset.sourceLine,
            );
            if (lineNumber)
              void onToggleTask(
                document,
                lineNumber,
                event.currentTarget.checked,
              );
          }}
        />
      ),
    }),
    [document, groupId, onOpenDocument, onToggleTask, saving],
  );

  const findPanel = findOpen ? (
    <form
      className="readonly-find-panel"
      onSubmit={(event) => {
        event.preventDefault();
        moveMatch(1);
      }}
    >
      <input
        aria-label="Find in current note"
        ref={findInputRef}
        value={findQuery}
        onChange={(event) => {
          activeMatchRef.current = 0;
          setFindQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setFindOpen(false);
          }
          if (event.key === "Enter" && event.shiftKey) {
            event.preventDefault();
            moveMatch(-1);
          }
        }}
      />
      <span ref={findResultRef} aria-live="polite" />
      <button type="button" onClick={() => moveMatch(-1)}>
        Previous
      </button>
      <button type="submit">Next</button>
      <button type="button" onClick={() => setFindOpen(false)}>
        Close
      </button>
    </form>
  ) : null;
  const findLayer = contentRef.current
    ?.closest(".document-view")
    ?.querySelector<HTMLElement>("[data-document-find-layer]");

  return (
    <div ref={contentRef} data-readonly-markdown="">
      {findPanel && findLayer ? createPortal(findPanel, findLayer) : findPanel}
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {document.content}
      </ReactMarkdown>
    </div>
  );
}
