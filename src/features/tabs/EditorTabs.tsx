import type { TabGroup } from "../../domain/types.ts";

function PaneToggle({ side, open, onClick, updateAvailable = false }: { side: "left" | "right"; open: boolean; onClick: () => void; updateAvailable?: boolean }) {
  const action = open ? "Hide" : "Show";
  const title = `${action} ${side} sidebar${side === "right" && updateAvailable ? ". An update is available." : ""}`;
  return (
    <button
      type="button"
      className={`pane-toggle pane-toggle-${side}`}
      onClick={onClick}
      aria-label={`${action} ${side} sidebar`}
      aria-description={side === "right" && updateAvailable ? "An update is available." : undefined}
      title={title}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
        <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.5" />
        {side === "left" ? <path d="M6 2.75v10.5" /> : <path d="M10 2.75v10.5" />}
      </svg>
      {side === "right" && updateAvailable ? <span className="update-available-dot" aria-hidden="true" /> : null}
    </button>
  );
}

export type EditorTabsProps = {
  group: TabGroup;
  groupCount: number;
  titleForId: (id: string) => string;
  isUntitledId: (id: string) => boolean;
  onActivate: (groupId: string, id: string) => void;
  onDragStart: (
    event: React.DragEvent<HTMLButtonElement>,
    id: string,
    groupId: string,
  ) => void;
  onDragEnd: () => void;
  onDragOverTab?: (
    event: React.DragEvent<HTMLButtonElement>,
    id: string,
    groupId: string,
  ) => void;
  onDropTab?: (event: React.DragEvent<HTMLButtonElement>, id: string, groupId: string) => void;
  dropIndex?: number | null;
  onCloseTab: (groupId: string, id: string) => void;
  onNewTab: (groupId: string) => void;
  onSplit: () => void;
  onCloseGroup: (groupId: string) => void;
  onPinTab: (groupId: string, id: string) => void;
  paneControls?: {
    leftOpen: boolean;
    rightOpen: boolean;
    updateAvailable: boolean;
    onToggleLeft: () => void;
    onToggleRight: () => void;
  };
};

export function EditorTabs({
  group,
  groupCount,
  titleForId,
  isUntitledId,
  onActivate,
  onDragStart,
  onDragEnd,
  onDragOverTab,
  onDropTab,
  dropIndex,
  onCloseTab,
  onNewTab,
  onSplit,
  onCloseGroup,
  onPinTab,
  paneControls,
}: EditorTabsProps) {
  return (
    <div className="editor-tabs">
      {paneControls && !paneControls.leftOpen ? (
        <div className="editor-pane-control-left" role="group" aria-label="Left sidebar">
            <PaneToggle side="left" open={false} onClick={paneControls.onToggleLeft} />
        </div>
      ) : null}
      <div className="tab-strip">
        {group.tabs.map((id) => (
          <button
            type="button"
            className={`editor-tab ${group.activeId === id ? "active" : ""} ${group.previewId === id ? "preview" : ""} ${dropIndex === group.tabs.indexOf(id) ? "drop-before" : ""} ${dropIndex === group.tabs.length && group.tabs.indexOf(id) === group.tabs.length - 1 ? "drop-after" : ""}`}
            onClick={() => onActivate(group.id, id)}
            onDoubleClick={() => onPinTab(group.id, id)}
            draggable
            onDragStart={(event) => onDragStart(event, id, group.id)}
            onDragEnd={onDragEnd}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              onDragOverTab?.(event, id, group.id);
            }}
            onDrop={(event) => onDropTab?.(event, id, group.id)}
            title={titleForId(id)}
            key={id}
          >
            <span className="tab-file-mark">
              {isUntitledId(id) ? "+" : "M"}
            </span>
            <span className="tab-title">{titleForId(id)}</span>
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
      {paneControls && !paneControls.rightOpen ? (
        <div className="editor-pane-control-right" role="group" aria-label="Right sidebar">
          <PaneToggle
            side="right"
            open={paneControls.rightOpen}
            updateAvailable={paneControls.updateAvailable}
            onClick={paneControls.onToggleRight}
          />
        </div>
      ) : null}
    </div>
  );
}
