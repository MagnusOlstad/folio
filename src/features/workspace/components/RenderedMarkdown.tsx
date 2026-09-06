import { useMemo } from "react";
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

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
      {document.content}
    </ReactMarkdown>
  );
}
