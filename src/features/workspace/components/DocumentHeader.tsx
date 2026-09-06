import type { ViewerDocument } from "../../../domain/types.ts";
import type { MetadataField } from "../types.ts";

type DocumentHeaderProps = {
  groupId: string;
  document: ViewerDocument;
  saving: boolean;
  editingKey: string | null;
  drafts: Record<string, string>;
  onBeginEditing: (
    groupId: string,
    document: ViewerDocument,
    field: MetadataField,
    saving: boolean,
  ) => void;
  onChangeDraft: (key: string, value: string) => void;
  onFinishEditing: (
    key: string,
    document: ViewerDocument,
    field: MetadataField,
    value: string,
  ) => void;
};

export function DocumentHeader({
  groupId,
  document,
  saving,
  editingKey,
  drafts,
  onBeginEditing,
  onChangeDraft,
  onFinishEditing,
}: DocumentHeaderProps) {
  const titleKey = `${groupId}:${document.id}:title`;
  const descriptionKey = `${groupId}:${document.id}:description`;

  return (
    <header className="document-heading">
      <p>
        {document.type}
        {document.stale ? " / stale" : ""}
      </p>
      {editingKey === titleKey ? (
        <input
          className="document-title-editor"
          value={drafts[titleKey] ?? document.title}
          onChange={(event) => onChangeDraft(titleKey, event.target.value)}
          onBlur={(event) =>
            onFinishEditing(
              titleKey,
              document,
              "title",
              event.currentTarget.value,
            )
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.value = document.title;
              event.currentTarget.blur();
            }
          }}
          aria-label={`Title for ${document.title}`}
          autoFocus
        />
      ) : document.movable ? (
        <button
          type="button"
          className="document-title"
          onClick={() =>
            onBeginEditing(groupId, document, "title", saving)
          }
          disabled={saving}
          title="Click to edit title"
        >
          {document.title}
        </button>
      ) : (
        <h1>{document.title}</h1>
      )}
      {editingKey === descriptionKey ? (
        <input
          className="document-description-editor"
          value={drafts[descriptionKey] ?? document.description}
          onChange={(event) =>
            onChangeDraft(descriptionKey, event.target.value)
          }
          onBlur={(event) =>
            onFinishEditing(
              descriptionKey,
              document,
              "description",
              event.currentTarget.value,
            )
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.value = document.description;
              event.currentTarget.blur();
            }
          }}
          aria-label={`Description for ${document.title}`}
          autoFocus
        />
      ) : document.deletable ? (
        <button
          type="button"
          className={`document-description ${document.description ? "" : "empty"}`}
          onClick={() =>
            onBeginEditing(groupId, document, "description", saving)
          }
          disabled={saving}
          title="Click to edit description"
        >
          {document.description || "Add description"}
        </button>
      ) : document.description ? (
        <span>{document.description}</span>
      ) : null}
    </header>
  );
}
