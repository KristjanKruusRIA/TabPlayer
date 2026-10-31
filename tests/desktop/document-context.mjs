// Snapshot assertions intentionally observe the active tab when the read begins.
// Async jobs and writes must capture their origin separately and keep its ID.
export function readDocumentRecord(page,documentId) {
  return page.evaluate(documentId=>window.__TAURI_INTERNALS__.invoke('project_snapshot',{documentId}),documentId);
}

export async function readActiveDocument(page) {
  const workspace=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot'));
  return (await readDocumentRecord(page,workspace.active.documentId)).snapshot;
}
