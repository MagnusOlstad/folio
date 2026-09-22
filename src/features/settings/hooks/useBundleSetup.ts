import { useCallback, useEffect, useRef, useState } from "react";
import { api, setActiveBundleId } from "../../../lib/api.ts";
import { readStorageItem, removeStorageItem, writeStorageItem } from "../../../lib/storage.ts";
import type { Bundle, BundleRegistryResponse } from "../../../domain/types.ts";

export type BundleSetupInput = {
  destination: "new" | "existing";
  source: "empty" | "existing" | "obsidian";
  name: string;
  markdownPath?: string;
  parentPath?: string;
  bundleId?: string;
  scanId?: string;
};

export function useBundleSetup() {
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [activeBundleId, setCurrentBundleId] = useState<string | null>(() => readStorageItem("folio:bundle-active:v1"));
  const activeBundleRef = useRef(activeBundleId);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const result = await api<BundleRegistryResponse>("/api/bundles");
    setBundles(result.bundles);
    setError(result.error || "");
    const storedId = readStorageItem("folio:bundle-active:v1");
    const nextId = result.bundles.find((bundle) => bundle.id === activeBundleRef.current)?.id
      || result.bundles.find((bundle) => bundle.id === storedId)?.id
      || result.bundles[0]?.id
      || null;
    setCurrentBundleId((current) => current && result.bundles.some((bundle) => bundle.id === current)
      ? current
      : nextId);
    activeBundleRef.current = nextId;
    setActiveBundleId(nextId);
    if (nextId) writeStorageItem("folio:bundle-active:v1", nextId);
  }, []);

  useEffect(() => {
    void refresh()
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Could not read bundles."))
      .finally(() => setReady(true));
  }, [refresh]);

  const selectBundle = useCallback((id: string) => {
    if (!bundles.some((bundle) => bundle.id === id)) return;
    setCurrentBundleId(id);
    activeBundleRef.current = id;
    setActiveBundleId(id);
    writeStorageItem("folio:bundle-active:v1", id);
  }, [bundles]);

  const restoreBundle = useCallback((id: string | null) => {
    activeBundleRef.current = id;
    setCurrentBundleId(id);
    setActiveBundleId(id);
    if (id) writeStorageItem("folio:bundle-active:v1", id);
    else removeStorageItem("folio:bundle-active:v1");
  }, []);

  const setupBundle = useCallback(async (input: BundleSetupInput) => {
    const result = await api<{ bundle: Bundle; bundles: Bundle[] }>("/api/bundles/setup", {
      method: "POST",
      body: JSON.stringify(input),
    });
    setBundles(result.bundles);
    setCurrentBundleId(result.bundle.id);
    activeBundleRef.current = result.bundle.id;
    setActiveBundleId(result.bundle.id);
    writeStorageItem("folio:bundle-active:v1", result.bundle.id);
    return result.bundle;
  }, []);

  const renameBundle = useCallback(async (id: string, name: string) => {
    const result = await api<{ bundles: Bundle[] }>(`/api/bundles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    setBundles(result.bundles);
  }, []);

  const detachBundle = useCallback(async (id: string) => {
    const result = await api<{ bundles: Bundle[] }>(`/api/bundles/${encodeURIComponent(id)}/detach`, { method: "POST" });
    setBundles(result.bundles);
    if (id === activeBundleId) {
      const next = result.bundles[0]?.id || null;
      setCurrentBundleId(next);
      activeBundleRef.current = next;
      setActiveBundleId(next);
      if (next) writeStorageItem("folio:bundle-active:v1", next);
      else removeStorageItem("folio:bundle-active:v1");
    }
  }, [activeBundleId]);

  return { bundles, activeBundleId, error, ready, refresh, selectBundle, restoreBundle, setupBundle, renameBundle, detachBundle };
}
