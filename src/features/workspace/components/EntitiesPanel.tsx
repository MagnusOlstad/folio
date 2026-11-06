import { useEffect, useMemo, useRef, useState } from "react";
import type { Entity, EntityCorrectionCommand, EntityCoverage, EntityJob, EntityJobMode, EntityMention, EntityNoteMentions, EntityRelatedSuggestion } from "../../../domain/entities.ts";
import { entityApiForBundle } from "../../../lib/entities-api.ts";
import { apiForBundle } from "../../../lib/api.ts";
import type { BundleFile } from "../../../domain/types.ts";
import { groupDismissedMentionsByType, groupMentionsByType, mergeFirstPage } from "../model/entity-view.ts";
import type { useEntityScope } from "../hooks/useEntityScope.ts";

type Props = {
  bundleId: string | null;
  note: { id: string; title: string; content: string; createdAt?: string; updatedAt?: string } | null;
  draft: string | undefined;
  onReveal: (mention: EntityMention) => void;
  onOpenNote: (noteId: string) => void;
  onCreateNote: (title: string) => Promise<string | null>;
  onOpenSettings: () => void;
  scope: ReturnType<typeof useEntityScope>;
};

export function EntitiesPanel({ bundleId, note, draft, onReveal, onOpenNote, onCreateNote, onOpenSettings, scope }: Props) {
  const api = useMemo(() => bundleId ? entityApiForBundle(bundleId) : null, [bundleId]);
  const noteId = note?.id ?? null;
  const [mentions, setMentions] = useState<EntityMention[]>([]);
  const [noteCoverage, setNoteCoverage] = useState<EntityNoteMentions | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [related, setRelated] = useState<EntityRelatedSuggestion[]>([]);
  const [jobs, setJobs] = useState<EntityJob[]>([]);
  const [settings, setSettings] = useState<{ enabled: boolean; modelId: "gliner25multi" } | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<Entity["type"] | "">("");
  const [activityFilter, setActivityFilter] = useState<"active" | "stale" | "all">("active");
  const { entityIds: selected, entities: selectedEntities, toggleEntity, clear: clearScope } = scope;
  const [detail, setDetail] = useState<Entity | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const detailRequest = useRef(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [undoToken, setUndoToken] = useState<string | null>(null);
  const [nextEntityCursor, setNextEntityCursor] = useState<string | null>(null);
  const [nextJobCursor, setNextJobCursor] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<EntityCoverage | undefined>();
  const [jobMode, setJobMode] = useState<EntityJobMode | null>(null);

  function openEntityDetail(entity: Entity) {
    setDetail(entity);
    const requestId = ++detailRequest.current;
    if (!api) return;
    void api.detail(entity.id).then((fresh) => {
      if (requestId === detailRequest.current) setDetail(fresh);
    }).catch((caught) => { if (requestId === detailRequest.current) setError(errorText(caught)); });
  }

  function closeEntityDetail() {
    detailRequest.current += 1;
    setDetail(null);
  }

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    void api.settings({ signal: controller.signal }).then(setSettings).catch((caught) => { if (!controller.signal.aborted) setError(errorText(caught)); });
    void api.list({ limit: 30, signal: controller.signal }).then((page) => { setEntities(page.items); setNextEntityCursor(page.nextCursor); setCoverage(page.coverage); }).catch((caught) => { if (!controller.signal.aborted) setError(errorText(caught)); });
    void api.latestUndo({ signal: controller.signal }).then((undo) => { setRevision(undo.revision); setUndoToken(undo.undoToken); }).catch((caught) => { if (!controller.signal.aborted) setError(errorText(caught)); });
    void api.jobs(undefined, 8, { signal: controller.signal }).then((page) => { setJobs(page.items); setNextJobCursor(page.nextCursor); setJobMode(page.mode); }).catch((caught) => { if (!controller.signal.aborted) setError(errorText(caught)); });
    if (noteId) {
      void api.noteMentions(noteId, { signal: controller.signal, includeDismissed: true }).then((result) => { setNoteCoverage(result); setMentions(result.items); }).catch((caught) => { if (!controller.signal.aborted) setError(errorText(caught)); });
      void api.related(noteId, undefined, 8, { signal: controller.signal }).then((page) => setRelated(page.items)).catch((caught) => { if (!controller.signal.aborted) setError(errorText(caught)); });
    }
    return () => controller.abort();
  }, [api, noteId]);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api.list({ q: query, type: typeFilter || undefined, activity: activityFilter, limit: 30, signal: controller.signal }).then((page) => {
        if (!controller.signal.aborted) { setEntities(page.items); setNextEntityCursor(page.nextCursor); }
      }).catch((caught) => { if (!controller.signal.aborted) setError(errorText(caught)); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [api, query, typeFilter, activityFilter]);

  useEffect(() => {
    if (!api) return;
    let stopped = false;
    let timer: number | null = null;
    let signature = "";
    let controller: AbortController | null = null;
    const poll = async () => {
      controller = new AbortController();
      try {
        const [jobResult, settingsResult] = await Promise.allSettled([
          api.jobs(undefined, 8, { signal: controller.signal }),
          api.settings({ signal: controller.signal }),
        ]);
        if (stopped) return;
        if (settingsResult.status === "fulfilled") setSettings(settingsResult.value);
        else if (!controller.signal.aborted) setError(errorText(settingsResult.reason));
        if (jobResult.status === "rejected") {
          if (!controller.signal.aborted) setError(errorText(jobResult.reason));
          return;
        }
        const jobPage = jobResult.value;
        const nextSignature = JSON.stringify([jobPage.mode, jobPage.items.map((job) => [job.id, job.state, job.completed, job.total, job.updatedAt])]);
        setJobs((current) => mergeFirstPage(current, jobPage.items)); setNextJobCursor(jobPage.nextCursor); setJobMode(jobPage.mode);
        if (signature && signature !== nextSignature) {
          const [listResult, noteResult, relatedResult] = await Promise.allSettled([
            api.list({ q: query, type: typeFilter || undefined, activity: activityFilter, limit: 30, signal: controller.signal }),
            noteId ? api.noteMentions(noteId, { signal: controller.signal, includeDismissed: true }) : Promise.resolve(null),
            noteId ? api.related(noteId, undefined, 8, { signal: controller.signal }) : Promise.resolve(null),
          ]);
          if (stopped) return;
          if (listResult.status === "fulfilled") { setEntities((current) => mergeFirstPage(current, listResult.value.items)); setNextEntityCursor(listResult.value.nextCursor); setCoverage(listResult.value.coverage); }
          else if (!controller.signal.aborted) setError(errorText(listResult.reason));
          if (noteResult.status === "fulfilled" && noteResult.value) { setMentions(noteResult.value.items); setNoteCoverage(noteResult.value); }
          else if (noteResult.status === "rejected" && !controller.signal.aborted) setError(errorText(noteResult.reason));
          if (relatedResult.status === "fulfilled") setRelated(relatedResult.value?.items ?? []);
          else if (!controller.signal.aborted) setError(errorText(relatedResult.reason));
        }
        signature = nextSignature;
      } catch (caught) {
        if (!stopped && !controller.signal.aborted) setError(errorText(caught));
      } finally {
        if (!stopped) timer = window.setTimeout(() => { void poll(); }, 1800);
      }
    };
    void poll();
    return () => { stopped = true; if (timer !== null) window.clearTimeout(timer); controller?.abort(); };
  }, [api, noteId, query, typeFilter, activityFilter]);

  async function refresh() {
    if (!api) return;
    const [entityResult, undoResult, mentionResult, relatedResult, detailResult] = await Promise.allSettled([
      api.list({ q: query, type: typeFilter || undefined, activity: activityFilter, limit: 30 }), api.latestUndo(),
      note ? api.noteMentions(note.id, { includeDismissed: true }) : Promise.resolve(null),
      note ? api.related(note.id, undefined, 8) : Promise.resolve(null),
      detail ? api.detail(detail.id) : Promise.resolve(null),
    ]);
    if (entityResult.status === "fulfilled") { setEntities((current) => mergeFirstPage(current, entityResult.value.items)); setNextEntityCursor(entityResult.value.nextCursor); setCoverage(entityResult.value.coverage); }
    if (undoResult.status === "fulfilled") { setRevision(undoResult.value.revision); setUndoToken(undoResult.value.undoToken); }
    if (mentionResult.status === "fulfilled") { setMentions(mentionResult.value?.items ?? []); setNoteCoverage(mentionResult.value); }
    if (relatedResult.status === "fulfilled") setRelated(relatedResult.value?.items ?? []);
    if (detailResult.status === "fulfilled" && detailResult.value) { setDetail(detailResult.value); setDetailRevision((value) => value + 1); }
    const failure = [entityResult, undoResult, mentionResult, relatedResult, detailResult].find((result) => result.status === "rejected");
    if (failure?.status === "rejected") setError(errorText(failure.reason));
  }
  async function correct(command: EntityCorrectionCommand) {
    if (!api) return;
    setBusy(true); setError("");
    try { await api.correct(revision, command); await refresh(); }
    catch (caught) { setError(errorText(caught)); try { await refresh(); } catch { /* keep the correction error visible */ } }
    finally { setBusy(false); }
  }
  async function runJob(input: { noteIds?: string[]; force?: boolean; reason?: "manual" | "rebuild" }) {
    if (!api) return;
    setBusy(true); setError("");
    try { await api.requestJob(input); const page = await api.jobs(undefined, 8); setJobs((current) => mergeFirstPage(current, page.items)); setNextJobCursor(page.nextCursor); }
    catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  }
  async function changeEnabled(enabled: boolean) {
    if (!api) return;
    setBusy(true); setError("");
    try { setSettings(await api.setEnabled(enabled)); }
    catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  }
  async function actOnJob(jobId: string, action: "pause" | "resume" | "cancel") {
    if (!api) return;
    try { await api.jobAction(jobId, action); const page = await api.jobs(undefined, 8); setJobs((current) => mergeFirstPage(current, page.items)); setNextJobCursor(page.nextCursor); setJobMode(page.mode); }
    catch (caught) { setError(errorText(caught)); }
  }
  async function loadMoreJobs() {
    if (!api || !nextJobCursor) return;
    try { const page = await api.jobs(nextJobCursor, 8); setJobs((current) => [...current, ...page.items]); setNextJobCursor(page.nextCursor); setJobMode(page.mode); }
    catch (caught) { setError(errorText(caught)); }
  }
  async function loadMoreEntities() {
    if (!api || !nextEntityCursor) return;
    try { const page = await api.list({ q: query, type: typeFilter || undefined, activity: activityFilter, limit: 30, cursor: nextEntityCursor }); setEntities((current) => [...current, ...page.items]); setNextEntityCursor(page.nextCursor); }
    catch (caught) { setError(errorText(caught)); }
  }
  async function undoLatest() {
    if (!api || !undoToken) return;
    setBusy(true); setError("");
    try { await api.undo(revision, undoToken); await refresh(); }
    catch (caught) { setError(errorText(caught)); try { await refresh(); } catch { /* preserve the undo conflict for recovery */ } }
    finally { setBusy(false); }
  }

  const grouped = groupMentionsByType(mentions);
  const dismissedGrouped = groupDismissedMentionsByType(mentions);
  const filtered = entities.filter((entity) => `${entity.label} ${entity.aliases.join(" ")}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (!typeFilter || entity.type === typeFilter));
  return <section className="entities-panel" aria-label="Entities">
    <header className="entities-panel-heading"><div><h2>Entities</h2><p>Names and topics found in this bundle’s notes.</p></div><button type="button" onClick={onOpenSettings}>Model settings</button></header>
    {error && <p role="alert" className="entities-error">{error} <button type="button" onClick={() => void refresh()}>Refresh</button></p>}
    <div className="entities-analysis-setting"><label><input type="checkbox" checked={settings?.enabled ?? false} disabled={!settings || busy} onChange={(event) => void changeEnabled(event.target.checked)} /> Analyze this bundle</label><button type="button" disabled={busy || !note} onClick={() => void runJob({ noteIds: note ? [note.id] : undefined, force: true, reason: "manual" })}>Analyze current note</button><button type="button" disabled={busy} onClick={() => void runJob({ force: true, reason: "rebuild" })}>Rebuild index</button><button type="button" disabled={busy || !undoToken} onClick={() => void undoLatest()}>Undo last correction</button></div>
    {note ? <div className="entities-current"><h3>In this note</h3>{draft !== undefined && <p role="status">Save this draft to refresh entity matches.</p>}{draft === undefined && noteCoverage?.freshness === "stale" && <p role="status">Entity matches are out of date and need analysis.</p>}{noteCoverage?.staleCount ? <p role="status">{noteCoverage.staleCount} stale mentions are hidden until this note is analyzed.</p> : null}{grouped.length === 0 && <p role={jobs.some((job) => job.items.some((item) => item.noteId === note.id && item.state === "failed")) ? "alert" : "status"}>{jobs.some((job) => job.items.some((item) => item.noteId === note.id && item.state === "failed")) ? (jobs.flatMap((job) => job.items).find((item) => item.noteId === note.id && item.state === "failed")?.error || "Analysis failed for this note. Retry the job from Analysis jobs.") : jobs.some((job) => job.items.some((item) => item.noteId === note.id && ["queued", "running", "paused"].includes(item.state))) ? "Analysis is in progress for this note." : dismissedGrouped.length ? "No active mentions. Dismissed mentions can be restored below." : settings?.enabled ? "No resolved entities found yet." : "Turn on analysis for this bundle to find entities in this note."}</p>}{grouped.map((group) => <section key={group.type}><h4>{group.label}</h4><ul>{group.mentions.map((mention) => <li key={mention.id}><button className="entity-mention-link" type="button" disabled={draft !== undefined} onClick={() => onReveal(mention)}>{mention.text}</button><span>{mention.resolution === "ambiguous" ? "Needs review" : mention.resolution}</span><button type="button" disabled={busy} onClick={() => void correct({ type: "dismiss", mentionIds: [mention.id] })}>Dismiss</button>{mention.resolution !== "resolved" && <><select aria-label={`Assign ${mention.text} to an entity`} defaultValue="" onChange={(event) => { if (event.target.value) void correct({ type: "reassign", mentionIds: [mention.id], entityId: event.target.value }); }}><option value="">Choose identity…</option>{entities.filter((entity) => entity.type === mention.type).map((entity) => <option key={entity.id} value={entity.id}>{entity.label}</option>)}</select><button type="button" disabled={busy} onClick={() => { const label = window.prompt("Name for this distinct identity", mention.text); if (label?.trim()) void correct({ type: "split", mentionIds: [mention.id], label: label.trim(), entityType: mention.type }); }}>Create distinct identity</button></>}</li>)}</ul></section>)}{dismissedGrouped.length > 0 && <section aria-label="Dismissed mentions"><h4>Dismissed mentions</h4>{dismissedGrouped.map((group) => <div key={group.type}><h5>{group.label}</h5><ul>{group.mentions.map((mention) => <li key={mention.id}><button className="entity-mention-link" type="button" disabled={draft !== undefined} onClick={() => onReveal(mention)}>{mention.text}</button><button type="button" disabled={busy} onClick={() => void correct({ type: "restore", mentionIds: [mention.id] })}>Restore</button></li>)}</ul></div>)}</section>}</div> : <p className="entities-empty">Open a note to see its entities and related notes.</p>}
    {note && <section className="entities-related"><h3>Related notes</h3><p>Notes that mention the same entities. Shared mentions are evidence of co-occurrence, not a relationship.</p>{related.length ? <ul>{related.map((item) => <li key={item.noteId}><button type="button" className="entity-note-link" onClick={() => onOpenNote(item.noteId)}>{item.title}</button>{item.noteDate && <time>{item.noteDate}</time>}<span>{item.sharedEntities.map((entity) => entity.label).join(", ")}</span><button type="button" disabled={busy} onClick={() => void correct({ type: "dismiss-related", noteId: note.id, relatedNoteId: item.noteId })}>Dismiss</button></li>)}</ul> : <p>No shared-entity suggestions.</p>}</section>}
    <section className="entities-browser"><h3>Browse entities</h3><label>Search entities<input value={query} onChange={(event) => { setQuery(event.target.value); setNextEntityCursor(null); }} placeholder="Search names and aliases" /></label><label>Type<select value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value as Entity["type"] | ""); setNextEntityCursor(null); }}><option value="">All types</option>{["person", "organization", "project", "product", "location"].map((type) => <option key={type} value={type}>{type}</option>)}</select></label><label>Activity<select value={activityFilter} onChange={(event) => { setActivityFilter(event.target.value as typeof activityFilter); setNextEntityCursor(null); }}><option value="active">Active</option><option value="stale">Stale</option><option value="all">All</option></select></label><p>{selected.length ? `Selected for search scope: ${selectedEntities.map((entity) => entity.label).join(", ")}` : "Select entities to scope a future search or Ask request."}</p>{selected.length > 0 && <button type="button" onClick={clearScope}>Clear scope</button>}<ul>{filtered.map((entity) => <li key={entity.id}><input aria-label={`Include ${entity.label} in scope`} type="checkbox" checked={selected.includes(entity.id)} onChange={(event) => toggleEntity(entity, event.target.checked)} /><button type="button" onClick={() => openEntityDetail(entity)}>{entity.label}</button><span>{entity.type} · {entity.noteCount} notes</span></li>)}</ul>{nextEntityCursor && <button type="button" onClick={() => void loadMoreEntities()}>Load more entities</button>}{detail && <EntityDetail key={`${detail.id}:${detailRevision}`} bundleId={bundleId} entity={detail} api={api} onClose={closeEntityDetail} onCommand={correct} busy={busy} currentNoteId={note?.id ?? null} entities={entities} onReveal={onReveal} onOpenNote={onOpenNote} onCreateNote={onCreateNote} />}</section>
    <section className="entities-jobs"><h3>Analysis jobs</h3>{coverage && <p role="status">Coverage: {coverage.processed}/{coverage.eligible} processed · {coverage.pending} pending · {coverage.stale} stale · {coverage.failed} failed{jobMode ? ` · ${jobMode.replaceAll("_", " ")}` : ""}</p>}{jobs.length ? <ul>{jobs.map((job) => <li key={job.id}><span>{job.reason}: {job.state} ({job.completed}/{job.total})</span><div>{job.state === "running" ? <button type="button" onClick={() => void actOnJob(job.id, "pause")}>Pause</button> : job.state === "paused" || job.state === "failed" || job.state === "partial" ? <button type="button" onClick={() => void actOnJob(job.id, "resume")}>{job.state === "failed" || job.state === "partial" ? "Retry failed" : "Resume"}</button> : null}{["queued", "running", "paused"].includes(job.state) && <button type="button" onClick={() => void actOnJob(job.id, "cancel")}>Cancel</button>}</div></li>)}</ul> : <p>No analysis jobs.</p>}{nextJobCursor && <button type="button" onClick={() => void loadMoreJobs()}>Load more jobs</button>}</section>
  </section>;
}

function EntityDetail({ bundleId, entity, api, onClose, onCommand, busy, currentNoteId, entities, onReveal, onOpenNote, onCreateNote }: { bundleId: string | null; entity: Entity; api: ReturnType<typeof entityApiForBundle> | null; onClose: () => void; onCommand: (command: EntityCorrectionCommand) => Promise<void>; busy: boolean; currentNoteId: string | null; entities: Entity[]; onReveal: (mention: EntityMention) => void; onOpenNote: (noteId: string) => void; onCreateNote: (title: string) => Promise<string | null> }) {
  const [mentions, setMentions] = useState<EntityMention[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [label, setLabel] = useState(entity.label);
  const [alias, setAlias] = useState("");
  const [targetId, setTargetId] = useState("");
  const [selectedMentionIds, setSelectedMentionIds] = useState<string[]>([]);
  const [entityType, setEntityType] = useState<Entity["type"]>(entity.type);
  const [noteQuery, setNoteQuery] = useState("");
  const [noteFiles, setNoteFiles] = useState<BundleFile[] | null>(null);
  const [targetEvidenceState, setTargetEvidenceState] = useState<{ targetId: string; items: EntityMention[] } | null>(null);
  const targetEvidence = targetEvidenceState?.targetId === targetId ? targetEvidenceState.items : [];
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    void api.mentions(entity.id, undefined, 30, { signal: controller.signal }).then((page) => { setMentions(page.items); setNextCursor(page.nextCursor); }).catch(() => {});
    return () => controller.abort();
  }, [api, entity.id]);
  useEffect(() => {
    if (!api || !targetId) return;
    const controller = new AbortController();
    void api.mentions(targetId, undefined, 3, { signal: controller.signal }).then((page) => { if (!controller.signal.aborted) setTargetEvidenceState({ targetId, items: page.items }); }).catch(() => {});
    return () => controller.abort();
  }, [api, targetId]);
  async function loadMore() { if (!api || !nextCursor) return; const page = await api.mentions(entity.id, nextCursor, 30); setMentions((current) => [...current, ...page.items]); setNextCursor(page.nextCursor); }
  const timeline = new Map<string, EntityMention[]>();
  for (const mention of mentions) {
    const date = mention.noteDate ? new Date(mention.noteDate) : null;
    const heading = date && Number.isFinite(date.valueOf()) ? date.toLocaleDateString(undefined, { year: "numeric", month: "long" }) : "Date unavailable";
    timeline.set(heading, [...(timeline.get(heading) ?? []), mention]);
  }
  const selectedTarget = entities.find((candidate) => candidate.id === targetId);
  return <div className="entity-detail" aria-label={`${entity.label} details`}><header><h4>{entity.label}</h4><button type="button" onClick={onClose}>Close</button></header><p>{entity.type} · {entity.noteCount} notes · {entity.mentionCount} mentions</p><label>Rename<input value={label} onChange={(event) => setLabel(event.target.value)} /></label><button type="button" disabled={busy || !label.trim() || label === entity.label} onClick={() => void onCommand({ type: "rename", entityId: entity.id, label: label.trim() })}>Save name</button><label>Add alias<input value={alias} onChange={(event) => setAlias(event.target.value)} /></label><button type="button" disabled={busy || !alias.trim()} onClick={() => void onCommand({ type: "add-alias", entityId: entity.id, alias: alias.trim() })}>Add alias</button>{entity.aliases.length > 0 && <ul aria-label="Aliases">{entity.aliases.map((item) => <li key={item}>{item}<button type="button" disabled={busy} onClick={() => void onCommand({ type: "remove-alias", entityId: entity.id, alias: item })}>Remove alias</button></li>)}</ul>}<label>Other identity<select value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">Choose an entity…</option>{entities.filter((candidate) => candidate.id !== entity.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label} ({candidate.type}) · {candidate.representativeNoteTitle || `${candidate.noteCount} notes`}</option>)}</select></label>{selectedTarget && <p role="status">Identity evidence · {entity.label}: {sourceEvidence(mentions)} · {selectedTarget.label}: {sourceEvidence(targetEvidence)}</p>}<button type="button" disabled={busy || !targetId || entities.find((candidate) => candidate.id === targetId)?.type !== entity.type} onClick={() => { const target = entities.find((candidate) => candidate.id === targetId); if (target && window.confirm(`Merge ${entity.label} (${sourceEvidence(mentions)}) into ${target.label} (${sourceEvidence(targetEvidence)})?`)) void onCommand({ type: "merge", entityId: entity.id, targetEntityId: target.id }); }}>Merge identities…</button><button type="button" disabled={busy || !targetId} onClick={() => { if (targetId) void onCommand({ type: "do-not-merge", leftEntityId: entity.id, rightEntityId: targetId }); }}>Keep these identities separate</button><label>Type<select value={entityType} onChange={(event) => setEntityType(event.target.value as Entity["type"])}>{["person", "organization", "project", "product", "location"].map((type) => <option key={type} value={type}>{type}</option>)}</select></label><button type="button" disabled={busy || entityType === entity.type} onClick={() => void onCommand({ type: "retype", entityId: entity.id, entityType })}>Save type</button>{currentNoteId && <button type="button" disabled={busy || entity.linkedNoteId === currentNoteId} onClick={() => void onCommand({ type: "link-note", entityId: entity.id, noteId: currentNoteId })}>Link to open note</button>}<label>Find existing notes<input value={noteQuery} onChange={(event) => setNoteQuery(event.target.value)} placeholder="Filter notes" /></label><button type="button" disabled={!bundleId || noteFiles !== null} onClick={() => { if (bundleId) void apiForBundle<BundleFile[]>(bundleId, "/api/files").then(setNoteFiles).catch(() => {}); }}>Load notes</button>{noteFiles && <ul aria-label="Existing notes">{noteFiles.filter((file) => file.deletable && `${file.title} ${file.id}`.toLocaleLowerCase().includes(noteQuery.toLocaleLowerCase())).slice(0, 20).map((file) => <li key={file.id}><button type="button" disabled={busy} onClick={() => void onCommand({ type: "link-note", entityId: entity.id, noteId: file.id })}>{file.title}</button></li>)}</ul>}<button type="button" onClick={() => { const title = window.prompt("Title for the new note about this entity", entity.label); if (title?.trim()) void onCreateNote(title.trim()).then((noteId) => { if (noteId) void onCommand({ type: "link-note", entityId: entity.id, noteId }); }); }}>Create note for entity…</button>{(entity.linkedNoteIds ?? (entity.linkedNoteId ? [entity.linkedNoteId] : [])).map((linkedNoteId) => <span key={linkedNoteId}><button type="button" disabled={busy} onClick={() => onOpenNote(linkedNoteId)}>Open linked note {linkedNoteId}</button><button type="button" disabled={busy} onClick={() => void onCommand({ type: "unlink-note", entityId: entity.id, noteId: linkedNoteId })}>Unlink {linkedNoteId}</button></span>)}<h5>Timeline by source note date</h5><p>The date is the note date, not an event date inferred from its text.</p>{selectedMentionIds.length > 0 && <div className="entity-mention-actions"><span>{selectedMentionIds.length} mentions selected</span><button type="button" disabled={busy} onClick={() => void onCommand({ type: "dismiss", mentionIds: selectedMentionIds })}>Dismiss selected</button><button type="button" disabled={busy} onClick={() => { const splitLabel = window.prompt("Label for the separate identity", entity.label); if (splitLabel?.trim()) void onCommand({ type: "split", entityId: entity.id, mentionIds: selectedMentionIds, label: splitLabel.trim(), entityType }); }}>Split into identity…</button><label>Reassign to<select defaultValue="" onChange={(event) => { if (event.target.value) void onCommand({ type: "reassign", mentionIds: selectedMentionIds, entityId: event.target.value }); }}><option value="">Choose identity…</option>{entities.filter((candidate) => candidate.id !== entity.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></label></div>}{[...timeline].map(([month, items]) => <section key={month}><h6>{month}</h6><ul>{items.map((mention) => <li key={mention.id}><input type="checkbox" aria-label={`Select mention in ${mention.noteTitle ?? mention.noteId}`} checked={selectedMentionIds.includes(mention.id)} onChange={(event) => setSelectedMentionIds((current) => event.target.checked ? [...current, mention.id] : current.filter((id) => id !== mention.id))} /><button type="button" className="entity-note-link" onClick={() => onReveal(mention)}>{mention.noteTitle ?? mention.noteId}</button>{mention.excerpt ? <blockquote>{mention.excerpt}</blockquote> : <span>{mention.text}</span>}{mention.noteDate && <time>{new Date(mention.noteDate).toLocaleDateString()}</time>}</li>)}</ul></section>)}{nextCursor && <button type="button" onClick={() => void loadMore()}>Load more mentions</button>}</div>;
}
function sourceEvidence(items: EntityMention[]) {
  return items.slice(0, 3).map((item) => `${item.noteTitle ?? item.noteId}: “${item.text}”`).join("; ") || "no current mention evidence";
}
function errorText(error: unknown) {
  if (error instanceof Error && "status" in error && error.status === 409) return "This entity changed elsewhere. The latest data is refreshed; review it and retry your correction.";
  return error instanceof Error ? error.message : "The entity request failed. Refresh and try again.";
}
