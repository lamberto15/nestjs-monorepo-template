/** A one-use, memory-only handoff for files already selected in this tab. */
export type AnalyticsHandoff = { file: File; expectedColumns?: string[] };

let handoff: AnalyticsHandoff | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;

export function stageAnalyticsFile(value: AnalyticsHandoff) {
  if (expiry) clearTimeout(expiry);
  handoff = value;
  // A file selected for profiling is a one-use navigation payload, not a tab cache.
  expiry = setTimeout(clearAnalyticsFile, 30_000);
}

export function takeAnalyticsFile() {
  const value = handoff;
  handoff = undefined;
  if (expiry) clearTimeout(expiry);
  expiry = undefined;
  return value;
}

export function clearAnalyticsFile() {
  handoff = undefined;
  if (expiry) clearTimeout(expiry);
  expiry = undefined;
}
