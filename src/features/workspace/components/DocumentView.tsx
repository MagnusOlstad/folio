import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { NoteTranslationTarget, ViewerDocument } from "../../../domain/types.ts";
import { getActiveBundleId } from "../../../lib/api.ts";
import { useNoteLanguage } from "../hooks/useNoteLanguage.ts";
import { useNoteTranslation } from "../hooks/useNoteTranslation.ts";
import { useTranslationSettings } from "../hooks/useTranslationSettings.ts";
import {
  isTranslatableDocument,
  readNoteTranslationChoices,
  setNoteTranslationChoice,
  subscribeNoteTranslationChoices,
  translatedProgressLabel,
} from "../model/note-translation.ts";
import type { TranslatedExportDeliver } from "../model/translated-export.ts";
import { RenderedMarkdown } from "./RenderedMarkdown.tsx";
import { isUntitledId } from "../../../lib/workspace.ts";
import { DocumentBody } from "./DocumentBody.tsx";
import { DocumentFooter } from "./DocumentFooter.tsx";
import { DocumentHeader } from "./DocumentHeader.tsx";
import type { MetadataField } from "../types.ts";
import type { FilingFields, FilingQueueEntry } from "../model/filing.ts";
import type { RefileEntry, RefileFields } from "../model/refile.ts";
import { FilingConfirmation } from "./FilingConfirmation.tsx";
import type { NoteExportFormat } from "../model/note-export.ts";
import { RefileDialog } from "./RefileDialog.tsx";

export type DocumentViewProps = {
  groupId: string;
  document: ViewerDocument;
  editKey: string;
  draft: string | undefined;
  saving: boolean;
  focusRequestId?: number;
  onFocusRequestConsumed?: () => void;
  deletingNoteId: string | null;
  movingFileId: string | null;
  exportingNoteId: string | null;
  filingDirectories: string[];
  editingMetadataKey: string | null;
  metadataDrafts: Record<string, string>;
  pathDraft: string | undefined;
  tagDraft: string | undefined;
  getScrollTop: (documentId: string) => number;
  getSelection: (documentId: string) => { from: number; to: number } | undefined;
  onSelectionChange: (documentId: string, from: number, to: number) => void;
  onScroll: (documentId: string, scrollTop: number) => void;
  onBeginMetadataEditing: (
    groupId: string,
    document: ViewerDocument,
    field: MetadataField,
  ) => void;
  onChangeMetadataDraft: (key: string, value: string) => void;
  onFinishMetadataEditing: (
    key: string,
    document: ViewerDocument,
    field: MetadataField,
    value: string,
  ) => void;
  onChangeContent: (document: ViewerDocument, content: string) => void;
  onFileDraft: (document: ViewerDocument) => void;
  onEditorError?: (message: string) => void;
  onBeginEditing: (
    groupId: string,
    document: ViewerDocument,
  ) => void;
  onFinishEditing: (
    groupId: string,
    document: ViewerDocument,
    scrollTop?: number,
  ) => void;
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
  onBeginPathEditing: (document: ViewerDocument) => void;
  onChangePath: (documentId: string, value: string) => void;
  onFinishPathEditing: (document: ViewerDocument, value: string) => void;
  onResetPath: (document: ViewerDocument) => void;
  onBeginTagEditing: (document: ViewerDocument) => void;
  onChangeTag: (documentId: string, value: string) => void;
  onFinishTagEditing: (document: ViewerDocument, value: string) => void;
  onDelete: (document: ViewerDocument) => Promise<void>;
  onExport: (document: ViewerDocument, format: NoteExportFormat) => void;
  onTranslatedExport?: TranslatedExportDeliver;
  filing: FilingQueueEntry | undefined;
  refile: RefileEntry | undefined;
  focusFiling: boolean;
  onChangeFilingFields: (documentId: string, fields: FilingFields) => void;
  onRevealStandaloneFiling: (documentId: string) => void;
  onConfirmFiling: (groupId: string, documentId: string, action: "accept" | "standalone") => void;
  onDismissFiling: (groupId: string, documentId: string) => void;
  onStartRefile: (documentId: string) => void;
  onChangeRefileFields: (documentId: string, fields: RefileFields) => void;
  onAcceptRefile: (documentId: string) => void;
  onDismissRefile: (documentId: string) => void;
};

export function DocumentView(props: DocumentViewProps) {
  const { document, getScrollTop, onScroll } = props;
  const scrollRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll) scroll.scrollTop = getScrollTop(document.id);
  }, [document.id, getScrollTop]);

  const draftId = isUntitledId(document.id);
  const translatable = isTranslatableDocument(document, draftId);
  const translationState = useTranslationSettings();
  const translationSettings = translationState.settings;
  const bundleId = getActiveBundleId();
  const choices = useSyncExternalStore(
    subscribeNoteTranslationChoices,
    () => readNoteTranslationChoices(bundleId),
  );
  const toggleVisible = translatable && translationSettings !== null;
  const translationOn = toggleVisible && translationSettings.enabled;
  const language = useNoteLanguage(document.id, translationOn, document.content, translationOn);
  const storedChoice = translationOn ? (choices[document.id] ?? null) : null;
  // A stored choice equal to the note's own language means "Original".
  const translationTarget = language.settled && storedChoice && storedChoice !== language.noteLanguage ? storedChoice : null;
  const translation = useNoteTranslation(document.id, translationTarget, document.content);
  const knownLanguage = translation.translation?.noteLanguage !== undefined
    ? translation.translation.noteLanguage
    : language.noteLanguage;
  const knownSource = translation.translation?.noteLanguageSource !== undefined
    ? translation.translation.noteLanguageSource
    : language.noteLanguageSource;
  const storedIsOriginal = storedChoice !== null && storedChoice === language.noteLanguage;
  useEffect(() => {
    if (storedIsOriginal) setNoteTranslationChoice(bundleId, document.id, null);
  }, [storedIsOriginal, bundleId, document.id]);
  const languageToggle = toggleVisible
    ? {
        enabled: translationSettings.enabled,
        saving: translationState.saving,
        error: translationState.error,
        onEnabledChange: (enabled: boolean) => void translationState.setEnabled(enabled),
        value: translationOn ? (translationTarget ?? knownLanguage) : null,
        originalLanguage: translationOn ? knownLanguage : null,
        originalSource: knownSource,
        available: translationSettings.available,
        // The original's own button (or the shown translation's button) returns to Original.
        onChange: (target: NoteTranslationTarget) =>
          setNoteTranslationChoice(
            bundleId,
            document.id,
            target === knownLanguage || target === translationTarget ? null : target,
          ),
      }
    : undefined;
  const translated = translation.translation;
  const translatedDocument: ViewerDocument = {
    ...document,
    title: translated?.title || document.title,
    description: translated ? translated.description : document.description,
    content: translated?.content ?? document.content,
    deletable: false,
    movable: false,
  };
  const translationNotice = !translationTarget
    ? ""
    : translation.error
      ? `${translation.error} Switch to Original to keep working.`
      : !translated
        ? "Loading translation…"
        : translated.status === "pending"
          ? translatedProgressLabel(translated.translatedBlocks, translated.totalBlocks)
          : translated.status === "ready"
            ? ""
            : "Translation is unavailable. Install a generation model in Settings.";

  return (
    <article
      className={`document-view ${isUntitledId(document.id) ? "untitled" : ""}`}
    >
      <div
        className="document-scroll"
        data-document-scroll
        ref={scrollRef}
        onScroll={(event) =>
          onScroll(document.id, event.currentTarget.scrollTop)
        }
      >
        {!isUntitledId(document.id) && (
          <DocumentHeader
            groupId={props.groupId}
            document={translationTarget ? translatedDocument : document}
            readOnly={Boolean(translationTarget)}
            languageToggle={languageToggle}
            editingKey={props.editingMetadataKey}
            drafts={props.metadataDrafts}
            onBeginEditing={props.onBeginMetadataEditing}
            onChangeDraft={props.onChangeMetadataDraft}
            onFinishEditing={props.onFinishMetadataEditing}
          />
        )}
        {translationTarget ? (
          <div className="document-content read-only translated-note" lang={translationTarget}>
            {translationNotice && (
              <p
                className={`translation-status${translation.error ? " is-error" : ""}`}
                role={translation.error ? "alert" : "status"}
              >
                {translationNotice}
              </p>
            )}
            <RenderedMarkdown
              key={`${document.id}:${translationTarget}`}
              document={translatedDocument}
              groupId={props.groupId}
              saving
              onOpenDocument={props.onOpenDocument}
              onToggleTask={async () => {}}
            />
          </div>
        ) : (
        <DocumentBody
          groupId={props.groupId}
          document={document}
          editKey={props.editKey}
          draft={props.draft}
          saving={props.saving}
          focusRequestId={props.focusRequestId}
          onFocusRequestConsumed={props.onFocusRequestConsumed}
          onChangeContent={props.onChangeContent}
          onFileDraft={props.onFileDraft}
          onEditorError={props.onEditorError}
          onFinishEditing={props.onFinishEditing}
          onBeginEditing={props.onBeginEditing}
          getSelection={props.getSelection}
          onSelectionChange={props.onSelectionChange}
          onOpenDocument={props.onOpenDocument}
          onToggleTask={props.onToggleTask}
        />
        )}
      </div>
      {props.filing && (
        <FilingConfirmation
          entry={props.filing}
          directories={props.filingDirectories}
          autoFocus={props.focusFiling}
          onChange={(fields) => props.onChangeFilingFields(document.id, fields)}
          onAccept={() => props.onConfirmFiling(props.groupId, document.id, "accept")}
          onStandalone={() => props.onConfirmFiling(props.groupId, document.id, "standalone")}
          onDismiss={() => props.onDismissFiling(props.groupId, document.id)}
          onRevealStandalone={() => props.onRevealStandaloneFiling(document.id)}
        />
      )}
      <div className="document-find-layer" data-document-find-layer />
      <DocumentFooter
        groupId={props.groupId}
        document={document}
        draft={props.draft}
        pathDraft={props.pathDraft}
        tagDraft={props.tagDraft}
        saving={props.saving}
        deleting={props.deletingNoteId === document.id}
        deleteInProgress={Boolean(props.deletingNoteId)}
        moving={props.movingFileId === document.id}
        exporting={props.exportingNoteId === document.id}
        onBeginPathEditing={props.onBeginPathEditing}
        onChangePath={props.onChangePath}
        onFinishPathEditing={props.onFinishPathEditing}
        onResetPath={props.onResetPath}
        onBeginTagEditing={props.onBeginTagEditing}
        onChangeTag={props.onChangeTag}
        onFinishTagEditing={props.onFinishTagEditing}
        onFileDraft={props.onFileDraft}
        onDelete={props.onDelete}
        onExport={props.onExport}
        onTranslatedExport={props.onTranslatedExport}
        onRefile={(target) => props.onStartRefile(target.id)}
        refileDisabled={props.refile?.status === "preparing" || props.refile?.status === "proposing" || props.refile?.status === "submitting"}
        refileTranslated={Boolean(translationTarget)}
        onOpenDocument={props.onOpenDocument}
      />
      {props.refile && (
        <RefileDialog
          entry={props.refile}
          directories={props.filingDirectories}
          onStart={() => props.onStartRefile(document.id)}
          onChange={(fields) => props.onChangeRefileFields(document.id, fields)}
          onAccept={() => props.onAcceptRefile(document.id)}
          onClose={() => props.onDismissRefile(document.id)}
        />
      )}
    </article>
  );
}
