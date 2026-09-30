export async function prepareFiledDocumentHistory(
  documentId: string,
  flushSave: (documentId: string) => Promise<void>,
  finalize: (documentId: string) => Promise<void>,
  isDirty: (documentId: string) => boolean,
) {
  await flushSave(documentId);
  if (isDirty(documentId)) throw new Error("Could not save the note before continuing with history.");
  await finalize(documentId);
  if (isDirty(documentId)) throw new Error("Could not save the note before continuing with history.");
}
