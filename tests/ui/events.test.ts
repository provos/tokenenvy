import { describe, expect, it } from 'vitest';
import {
  parseScanStatus,
  quotaWindowIsStale,
  scanRefreshTarget
} from '../../src/routes/+page.svelte';

const status = {
  state: 'scanning',
  filesDiscovered: 12,
  filesScanned: 4,
  bytesRead: 1024,
  rowsRead: 42,
  invalidRows: 1,
  updatedAt: '2026-08-14T12:00:00.000Z',
  lastError: null,
  revision: 7
};

describe('dashboard event parsing', () => {
  it('accepts complete scan status events', () => {
    expect(parseScanStatus(JSON.stringify(status))).toEqual(status);
  });

  it('rejects malformed and partial event payloads', () => {
    expect(parseScanStatus('{')).toBeNull();
    expect(parseScanStatus(JSON.stringify({ ...status, revision: -1 }))).toBeNull();
    expect(parseScanStatus(JSON.stringify({ ...status, rowsRead: '42' }))).toBeNull();
    expect(parseScanStatus(JSON.stringify({ state: 'idle', revision: 7 }))).toBeNull();
  });

  it('does not repeat analytics until the indexed revision advances', () => {
    expect(scanRefreshTarget(null, 0)).toBe('none');
    expect(scanRefreshTarget(7, 6)).toBe('none');
    expect(scanRefreshTarget(7, 7)).toBe('quota');
    expect(scanRefreshTarget(7, 8)).toBe('dashboard');
  });

  it('expires quota readings after fifteen minutes or at their reset boundary', () => {
    const window = {
      usedPercentage: 70,
      observedAt: '2026-08-14T12:00:00.000Z',
      resetsAt: '2026-08-14T13:00:00.000Z',
      stale: false
    };
    expect(quotaWindowIsStale(window, Date.parse('2026-08-14T12:15:00.000Z'))).toBe(false);
    expect(quotaWindowIsStale(window, Date.parse('2026-08-14T12:15:00.001Z'))).toBe(true);
    expect(quotaWindowIsStale(window, Date.parse('2026-08-14T13:00:00.000Z'))).toBe(true);
    expect(quotaWindowIsStale({ ...window, stale: true }, Date.parse('2026-08-14T12:01:00.000Z'))).toBe(true);
  });
});
