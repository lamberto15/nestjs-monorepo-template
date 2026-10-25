import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAnalyticsFile,
  stageAnalyticsFile,
  takeAnalyticsFile,
} from './handoff';

afterEach(() => {
  clearAnalyticsFile();
  vi.useRealTimers();
});

describe('local file handoff', () => {
  it('hands a selected file and its expected columns to one explorer only', () => {
    const file = new File(['id\n1'], 'notes.csv');
    stageAnalyticsFile({ file, expectedColumns: ['id'] });
    expect(takeAnalyticsFile()).toEqual({ file, expectedColumns: ['id'] });
    expect(takeAnalyticsFile()).toBeUndefined();
  });

  it('discards an unused file after thirty seconds', () => {
    vi.useFakeTimers();
    stageAnalyticsFile({ file: new File(['[]'], 'notes.json') });
    vi.advanceTimersByTime(30_000);
    expect(takeAnalyticsFile()).toBeUndefined();
  });

  it('gives a replacement file its own expiry and clears it on session cleanup', () => {
    vi.useFakeTimers();
    stageAnalyticsFile({ file: new File(['old'], 'old.csv') });
    vi.advanceTimersByTime(20_000);
    const replacement = new File(['new'], 'new.csv');
    stageAnalyticsFile({ file: replacement });
    vi.advanceTimersByTime(10_000);
    expect(takeAnalyticsFile()?.file).toBe(replacement);
    stageAnalyticsFile({ file: replacement });
    clearAnalyticsFile();
    expect(takeAnalyticsFile()).toBeUndefined();
  });
});
