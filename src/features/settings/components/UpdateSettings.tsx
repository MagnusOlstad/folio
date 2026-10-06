import { useState } from "react";
import type { VersionInfo } from "../../../domain/types.ts";
import { useDesktopUpdateState } from "../../workspace/hooks/useDesktopUpdateState.ts";

export function UpdateSettings() {
  const updateState = useDesktopUpdateState();
  const [checking, setChecking] = useState(false);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [error, setError] = useState("");
  const desktop = updateState !== null;
  const busy = checking || updateState?.status === "checking";
  const changing = ["downloading", "downloaded", "staging", "installing"].includes(updateState?.status ?? "");

  async function checkForUpdates() {
    setChecking(true);
    setError("");
    setVersionInfo(null);
    try {
      const checkedState = await window.folio?.checkForUpdates?.();
      if (!checkedState) {
        const response = await fetch("/api/version?refresh=1");
        if (!response.ok) throw new Error("Could not check for updates. Try again.");
        setVersionInfo(await response.json() as VersionInfo);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not check for updates. Try again.");
    } finally {
      setChecking(false);
    }
  }

  async function startUpdate() {
    setError("");
    try {
      await window.folio?.startUpdate?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the update. Try again.");
    }
  }

  let status = "";
  if (desktop) {
    if (updateState?.status === "checking" || busy) status = "Checking for updates…";
    else if (updateState?.status === "available") status = `Version ${updateState.version ?? "new"} is available.`;
    else if (updateState?.status === "idle") status = "FolioNotes is up to date.";
    else if (updateState?.status === "downloading") status = `Downloading update${updateState.percent === null ? "…" : `: ${updateState.percent}%`}`;
    else if (updateState?.status === "downloaded") status = "Download complete. Preparing installation…";
    else if (updateState?.status === "staging") status = "Preparing installation…";
    else if (updateState?.status === "installing") status = "Restarting FolioNotes to install the update…";
    else if (updateState?.status === "error") status = updateState.error ?? "The update failed. Try again.";
  } else if (versionInfo) {
    status = versionInfo.updateAvailable
      ? `Version ${versionInfo.latest} is available.`
      : versionInfo.checkError
        ? "Could not check for updates. Try again."
        : "FolioNotes is up to date.";
  }

  const canDownload = desktop && (updateState?.status === "available"
    || (updateState?.status === "error" && Boolean(updateState.version))) && !changing;
  const canCheck = !busy && !changing;

  return (
    <section className="settings-section" aria-labelledby="settings-updates-heading">
      <div className="settings-section-copy">
        <h2 id="settings-updates-heading">Updates</h2>
        <p>Check for the latest stable FolioNotes release.</p>
      </div>
      <div className="settings-update-actions">
        <button type="button" onClick={() => void checkForUpdates()} disabled={!canCheck}>
          {busy ? "Checking…" : "Check for updates"}
        </button>
        {canDownload ? (
          <button type="button" onClick={() => void startUpdate()}>
            {updateState?.status === "error" ? "Retry update" : `Download and install ${updateState?.version ? `v${updateState.version}` : "update"}`}
          </button>
        ) : null}
      </div>
      {desktop && updateState?.status === "downloading" && updateState.percent !== null ? (
        <progress max={100} value={updateState.percent} aria-label="Downloading update" />
      ) : null}
      {status ? <p role={updateState?.status === "error" || Boolean(versionInfo?.checkError) ? "alert" : "status"}>{status}</p> : null}
      {versionInfo?.updateAvailable && versionInfo.latestUrl ? (
        <a href={versionInfo.latestUrl} target="_blank" rel="noreferrer">View release</a>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {desktop && changing ? <p>FolioNotes will save pending changes before restarting to finish installation.</p> : null}
    </section>
  );
}
