/**
 * BullMQ rejects custom job ids that contain ':' or are integers. Both queue implementations check
 * this so a bad id fails in dev and tests, not only against Redis. Use '-' or '_' as separators.
 */
export function assertJobId(jobId: string | undefined): void {
  if (jobId === undefined) return;
  if (jobId.includes(':'))
    throw new Error(`Job id must not contain ':' (${jobId})`);
  if (/^\d+$/.test(jobId))
    throw new Error(`Job id must not be an integer (${jobId})`);
}
