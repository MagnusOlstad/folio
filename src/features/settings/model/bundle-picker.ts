export async function selectBundleFolder(): Promise<string | null> {
  if (window.folio?.selectFolder) return window.folio.selectFolder();
  // Browser handles intentionally do not expose absolute paths. Never send a
  // display name as if it were a server filesystem path.
  return null;
}
