import type { TabGroup } from "../../domain/types.ts";

export type EditorTabsProps = {
  group: TabGroup;
  groupCount: number;
  savingDocumentIds: Set<string>;
  titleForId: (id: string) => string;
  isUntitledId: (id: string) => boolean;
  onActivate: (groupId: string, id: string) => void;
  onDragStart: (
    event: React.DragEvent<HTMLButtonElement>,
    id: string,
    groupId: string,
  ) => void;
  onDragEnd: () => void;
  onCloseTab: (groupId: string, id: string) => void;
  onNewTab: (groupId: string) => void;
  onSplit: () => void;
  onCloseGroup: (groupId: string) => void;
};

export function EditorTabs({
  group,
  groupCount,
  savingDocumentIds,
  titleForId,
  isUntitledId,
  onActivate,
  onDragStart,
  onDragEnd,
  onCloseTab,
  onNewTab,
  onSplit,
  onCloseGroup,
}: EditorTabsProps) {
  return (
    <div className="editor-tabs">
      <div className="tab-strip">
        {group.tabs.map((id) => (
          <button
            type="button"
            className={`editor-tab ${group.activeId === id ? "active" : ""}`}
            onClick={() => onActivate(group.id, id)}
            draggable
            onDragStart={(event) => onDragStart(event, id, group.id)}
            onDragEnd={onDragEnd}
            title={id}
            key={id}
          >
            <span className="tab-file-mark">
              {isUntitledId(id) ? "+" : "M"}
            </span>
            <span>{titleForId(id)}</span>
            {savingDocumentIds.has(id) && (
              <span className="tab-saving" title="Saving" />
            )}
            <span
              className="tab-close"
              role="button"
              tabIndex={0}
              aria-label={`Close ${titleForId(id)}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(group.id, id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onCloseTab(group.id, id);
                }
              }}
            >
              x
            </span>
          </button>
        ))}
      </div>
      <div className="group-actions">
        <button
          type="button"
          onClick={() => onNewTab(group.id)}
          title="New note (Cmd+T)"
          aria-label="New note"
        >
          +
        </button>
        {groupCount === 1 ? (
          <button type="button" onClick={onSplit} title="Split editor">
            Split
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onCloseGroup(group.id)}
            title="Close editor group"
          >
            Close group
          </button>
        )}
      </div>
    </div>
  );
}
