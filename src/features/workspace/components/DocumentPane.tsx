import type { ReactNode } from "react";

type DocumentPaneProps = {
  groupId: string;
  hasDocument: boolean;
  loading: boolean;
  children: ReactNode;
  onCreateNewTab: (groupId: string) => void;
};

export function DocumentPane({
  groupId,
  hasDocument,
  loading,
  children,
  onCreateNewTab,
}: DocumentPaneProps) {
  return (
    <div className="editor-surface">
      {loading ? (
        <div className="editor-placeholder">
          <span>Opening file...</span>
        </div>
      ) : hasDocument ? (
        children
      ) : (
        <div className="editor-placeholder">
          <span className="empty-mark">F</span>
          <h1>Open a note.</h1>
          <p>
            Explore the bundle, search by meaning, or ask a question. Every file
            opens here.
          </p>
          <button
            type="button"
            className="empty-new-note"
            onClick={() => onCreateNewTab(groupId)}
          >
            New note
          </button>
        </div>
      )}
    </div>
  );
}
