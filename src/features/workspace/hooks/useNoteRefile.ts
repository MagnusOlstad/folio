import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefileResult } from "../../../domain/types.ts";
import { apiForBundle } from "../../../lib/api.ts";
import {
  initialRefileEntry,
  removeRefileEntry,
  refileRequestFields,
  setRefileEntry,
  updateRefileFields,
} from "../model/refile.ts";
import type { RefileEntries, RefileFields, RefileProposal } from "../model/refile.ts";

type UseNoteRefileOptions = {
  bundleId: string | null;
  prepare: (documentId: string) => Promise<boolean>;
  onComplete: (result: RefileResult) => void;
};

const EMPTY_REFILE_ENTRIES: RefileEntries = {};

export function useNoteRefile({ bundleId, prepare, onComplete }: UseNoteRefileOptions) {
  const [entryState, setEntryState] = useState<{
    bundleId: string | null;
    epoch: number;
    entries: RefileEntries;
  }>(() => ({ bundleId, epoch: 0, entries: {} }));
  const [bundleEpoch, setBundleEpoch] = useState(0);
  const generationsRef = useRef(new Map<string, number>());
  const requestSequenceRef = useRef(0);
  const bundleIdRef = useRef(bundleId);
  const previousBundleIdRef = useRef(bundleId);
  const prepareRef = useRef(prepare);
  const onCompleteRef = useRef(onComplete);
  useLayoutEffect(() => {
    prepareRef.current = prepare;
    onCompleteRef.current = onComplete;
    bundleIdRef.current = bundleId;
  }, [bundleId, onComplete, prepare]);

  useEffect(() => {
    if (previousBundleIdRef.current === bundleId) return;
    previousBundleIdRef.current = bundleId;
    // Refile proposals are scoped to a bundle; switching bundles invalidates pending reviews.
    generationsRef.current.clear();
    // oxlint-disable-next-line react/set-state-in-effect
    setBundleEpoch((epoch) => epoch + 1);
  }, [bundleId]);

  useEffect(() => () => {
    generationsRef.current.clear();
  }, []);

  const nextGeneration = (documentId: string) => {
    const generation = ++requestSequenceRef.current;
    generationsRef.current.set(documentId, generation);
    return generation;
  };

  const isCurrent = (documentId: string, generation: number, requestBundleId: string | null) =>
    bundleIdRef.current === requestBundleId && generationsRef.current.get(documentId) === generation;
  const entries = entryState.bundleId === bundleId && entryState.epoch === bundleEpoch
    ? entryState.entries
    : EMPTY_REFILE_ENTRIES;
  const entriesRef = useRef(entries);
  useLayoutEffect(() => { entriesRef.current = entries; }, [entries]);
  const updateEntries = useCallback((update: (current: RefileEntries) => RefileEntries) => {
    const requestBundleId = bundleId;
    const epoch = bundleEpoch;
    setEntryState((current) => {
      const currentEntries = current.bundleId === requestBundleId && current.epoch === epoch
        ? current.entries
        : {};
      return { bundleId: requestBundleId, epoch, entries: update(currentEntries) };
    });
  }, [bundleEpoch, bundleId]);

  const start = useCallback(async (documentId: string) => {
    const existing = entriesRef.current[documentId];
    if (existing && existing.status !== "error") return;
    if (existing?.proposal) return;

    const generation = nextGeneration(documentId);
    const requestBundleId = bundleId;
    updateEntries((current) => setRefileEntry(current, initialRefileEntry(documentId)));
    try {
      const ready = await prepareRef.current(documentId);
      if (!isCurrent(documentId, generation, requestBundleId)) return;
      if (!ready) {
        updateEntries((current) => {
          const entry = current[documentId];
          return entry ? setRefileEntry(current, {
            ...entry,
            status: "error",
            error: "Could not save the latest note edits before refiling.",
          }) : current;
        });
        return;
      }

      updateEntries((current) => {
        const entry = current[documentId];
        return entry ? setRefileEntry(current, { ...entry, status: "proposing" }) : current;
      });
      const proposal = await apiForBundle<RefileProposal>(requestBundleId, "/api/file/refile/propose", {
        method: "POST",
        body: JSON.stringify({ id: documentId }),
      });
      if (!isCurrent(documentId, generation, requestBundleId)) return;
      updateEntries((current) => {
        const entry = current[documentId];
        return entry ? setRefileEntry(current, {
          ...entry,
          status: "ready",
          proposal,
          fields: { ...proposal.proposal, tags: [...proposal.proposal.tags] },
          error: null,
        }) : current;
      });
    } catch (reason) {
      if (!isCurrent(documentId, generation, requestBundleId)) return;
      const error = reason instanceof Error ? reason.message : "Could not propose a new filing.";
      updateEntries((current) => {
        const entry = current[documentId];
        return entry ? setRefileEntry(current, { ...entry, status: "error", error }) : current;
      });
    }
  }, [bundleId, updateEntries]);

  const change = useCallback((documentId: string, fields: RefileFields) => {
    updateEntries((current) => updateRefileFields(current, documentId, fields));
  }, [updateEntries]);

  const dismiss = useCallback((documentId: string) => {
    nextGeneration(documentId);
    updateEntries((current) => removeRefileEntry(current, documentId));
  }, [updateEntries]);

  const accept = useCallback(async (documentId: string) => {
    const entry = entriesRef.current[documentId];
    if (!entry?.proposal || !entry.fields || entry.status === "submitting") return;
    const generation = generationsRef.current.get(documentId);
    if (generation === undefined) return;
    const requestBundleId = bundleId;
    updateEntries((current) => {
      const currentEntry = current[documentId];
      return currentEntry ? setRefileEntry(current, { ...currentEntry, status: "submitting", error: null }) : current;
    });
    try {
      const result = await apiForBundle<RefileResult>(requestBundleId, "/api/file/refile", {
        method: "POST",
        body: JSON.stringify({
          id: entry.proposal.id,
          hash: entry.proposal.hash,
          fields: refileRequestFields(entry.fields),
        }),
      });
      if (!isCurrent(documentId, generation, requestBundleId)) return;
      updateEntries((current) => removeRefileEntry(current, documentId));
      onCompleteRef.current(result);
    } catch (reason) {
      if (!isCurrent(documentId, generation, requestBundleId)) return;
      const error = reason instanceof Error ? reason.message : "Could not refile this note.";
      updateEntries((current) => {
        const currentEntry = current[documentId];
        return currentEntry ? setRefileEntry(current, { ...currentEntry, status: "error", error }) : current;
      });
    }
  }, [bundleId, updateEntries]);

  return { entries, start, change, accept, dismiss };
}
