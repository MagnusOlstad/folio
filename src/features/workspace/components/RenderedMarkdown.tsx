import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import type { ViewerDocument } from "../../../domain/types.ts";
import { conceptUrl, resolveBundleLink } from "../../../lib/paths.ts";
import { sourcePosition } from "../../../lib/workspace.ts";
import { folioMarkdown } from "../model/folio-markdown.ts";
import { readonlyMarkdownSearch } from "../model/readonly-markdown-search.ts";

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
  const findScrollTopRef = useRef(0);
  const matchesRef = useRef<HTMLElement[]>([]);
  const [findResult, setFindResult] = useState({
    index: 0,
    count: 0,
    content: document.content,
    query: "",
  });
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findLayer, setFindLayer] = useState<HTMLElement | null>(null);

  const searchQuery = findOpen ? findQuery : "";
  const activeIndex =
    findResult.content === document.content && findResult.query === searchQuery
      ? findResult.index
      : 0;
  const searchPlugins = useMemo<PluggableList>(
    () => [[readonlyMarkdownSearch, { query: searchQuery, activeIndex }]],
    [searchQuery, activeIndex],
  );

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const openFind = () => {
      findScrollTopRef.current =
        content.closest<HTMLElement>("[data-document-scroll]")?.scrollTop ?? 0;
      setFindLayer(
        content
          .closest(".document-view")
          ?.querySelector<HTMLElement>("[data-document-find-layer]") ?? null,
      );
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
    matchesRef.current = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>(
        "mark.readonly-search-match",
      ) ?? [],
    );
  });

  useLayoutEffect(() => {
    const count = matchesRef.current.length;
    setFindResult((previous) => {
      const index =
        previous.content === document.content && previous.query === searchQuery
          ? previous.index
          : 0;
      if (
        previous.count === count &&
        previous.content === document.content &&
        previous.query === searchQuery
      )
        return previous;
      return { index, count, content: document.content, query: searchQuery };
    });
  }, [document.content, searchQuery]);

  useLayoutEffect(() => {
    if (findOpen)
      matchesRef.current[activeIndex]?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
  }, [document.content, searchQuery, findOpen, activeIndex]);

  function moveMatch(direction: 1 | -1) {
    const count = matchesRef.current.length;
    if (!count) return;
    setFindResult((previous) => ({
      ...previous,
      count,
      content: document.content,
      query: searchQuery,
      index: (previous.index + direction + count) % count,
    }));
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
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
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
      <span aria-live="polite">
        {findResult.count
          ? `${activeIndex + 1} of ${findResult.count}`
          : findQuery
            ? "No matches"
            : ""}
      </span>
      <button type="button" onClick={() => moveMatch(-1)}>
        Previous
      </button>
      <button type="submit">Next</button>
      <button type="button" onClick={() => setFindOpen(false)}>
        Close
      </button>
    </form>
  ) : null;
  return (
    <div ref={contentRef} data-readonly-markdown="">
      {findPanel && findLayer ? createPortal(findPanel, findLayer) : findPanel}
      <ReactMarkdown
        remarkPlugins={[folioMarkdown, remarkGfm, remarkBreaks]}
        rehypePlugins={searchPlugins}
        components={components}
      >
        {document.content}
      </ReactMarkdown>
    </div>
  );
}
