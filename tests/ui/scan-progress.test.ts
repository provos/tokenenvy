import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ScanProgress, {
  formatScanBytes,
  scanPercent
} from '../../src/lib/components/ScanProgress.svelte';
import type { ScanStatus } from '../../src/lib/types';

const scanning: ScanStatus = {
  state: 'scanning',
  filesDiscovered: 200,
  filesScanned: 50,
  bytesRead: 12_582_912,
  rowsRead: 42_000,
  invalidRows: 2,
  updatedAt: '2026-08-14T18:00:00.000Z',
  lastError: null,
  revision: 0
};

describe('startup scan progress', () => {
  it('renders determinate file progress and live work counters', () => {
    const { body } = render(ScanProgress, { props: { status: scanning } });

    expect(scanPercent(scanning)).toBe(25);
    expect(body).toContain('value="50"');
    expect(body).toContain('25%');
    expect(body).toContain('50 of 200 files');
    expect(body).toContain('12.0 MB read');
    expect(body).toContain('42,000 rows inspected');
  });

  it('uses an indeterminate meter during discovery', () => {
    const { body } = render(ScanProgress, {
      props: { status: { ...scanning, state: 'discovering', filesScanned: 0 } }
    });

    expect(scanPercent({ ...scanning, state: 'discovering' })).toBeNull();
    expect(body).toContain('<progress');
    expect(body).not.toContain('value=');
    expect(body).toContain('Finding Claude Code session logs');
  });

  it('formats byte counters compactly', () => {
    expect(formatScanBytes(0)).toBe('0 B');
    expect(formatScanBytes(1_536)).toBe('1.5 KB');
    expect(formatScanBytes(1_572_864)).toBe('1.5 MB');
  });
});
