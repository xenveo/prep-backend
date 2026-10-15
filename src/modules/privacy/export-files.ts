import type { StorageAdapter } from '../../adapters/storage/storage.adapter.js';

// Export storage layout: a workspace export is a folder of CSVs (`ExportJob.fileKey` ends in '/'),
// a candidate export a single JSON file.

export const WORKSPACE_EXPORT_FILES = [
  'candidates.csv',
  'sessions.csv',
  'scores.csv',
] as const;

export const workspaceExportPrefix = (jobId: string) => `exports/${jobId}/`;
export const candidateExportKey = (jobId: string) => `exports/${jobId}.json`;

/** Download links in export emails and responses last 24 hours. */
export const EXPORT_LINK_TTL_SEC = 24 * 3600;

/** Deletes an export's file or folder; returns the number of objects removed. */
export async function deleteExportFiles(
  storage: StorageAdapter,
  fileKey: string,
): Promise<number> {
  if (fileKey.endsWith('/')) return storage.deletePrefix(fileKey);
  await storage.delete(fileKey);
  return 1;
}
