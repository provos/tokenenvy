// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import type { OverviewResponse, ScanStatus, SeriesResponse } from '../../src/lib/types';
import Dashboard from '../../src/routes/+page.svelte';
import DashboardRefreshHarness from './fixtures/DashboardRefreshHarness.svelte';

vi.mock('$env/dynamic/public', () => ({ env: {} }));

function click(target: ParentNode, testId: string) {
  const button = target.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`Missing ${testId}`);
  flushSync(() => button.click());
}

interface FetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

type ScanEventHandler = (event: { data: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  onerror: ((...args: unknown[]) => void) | null = null;
  readonly scanHandlers: ScanEventHandler[] = [];

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: ScanEventHandler) {
    if (type === 'scan') this.scanHandlers.push(handler);
  }

  close() {
    this.closed = true;
  }

  emitScan(status: ScanStatus) {
    const data = JSON.stringify(status);
    for (const handler of this.scanHandlers) handler({ data });
  }
}

function jsonResponse(payload: unknown): FetchResponse {
  return { ok: true, status: 200, json: () => Promise.resolve(payload) };
}

function statusResponse(status: number): FetchResponse {
  return { ok: false, status, json: () => Promise.resolve({}) };
}

const scanStatus: ScanStatus = {
  state: 'idle',
  filesDiscovered: 3,
  filesScanned: 3,
  bytesRead: 2_048,
  rowsRead: 10,
  invalidRows: 0,
  updatedAt: '2026-08-14T12:00:00.000Z',
  lastError: null,
  revision: 7,
};

const emptySpeedIndex = {
  value: null,
  ciLow: null,
  ciHigh: null,
  percentile: null,
  eligible: false,
  reason: 'Waiting for measured requests',
};

const overviewPayload: OverviewResponse = {
  generatedAt: '2026-08-14T12:00:00.000Z',
  timezone: 'UTC',
  today: '2026-08-14',
  headline: {
    count: 0,
    sessions: 0,
    median: 0,
    q1: 0,
    q3: 0,
    p10: 0,
    p90: 0,
    ciLow: null,
    ciHigh: null,
    outputTokens: 0,
    provisional: 0,
  },
  speedIndex: emptySpeedIndex,
  models: [],
  weekly: {
    outputTokens: 0,
    projectedOutputTokens: null,
    elapsedFraction: 0.5,
    previousFourWeekMedian: null,
    recap: {
      weekStart: '2026-08-10',
      throughDate: '2026-08-14',
      daysObserved: 0,
      observedDates: [],
      requestCount: 0,
      sessions: 0,
      median: null,
      speedIndex: emptySpeedIndex,
      models: [],
      fastestDay: null,
      slowestDay: null,
      refusals: {
        recorded: false,
        attempted: 0,
        recovered: 0,
        userVisible: 0,
        unknown: 0,
        affectedDates: [],
      },
    },
  },
  refusals: {
    recorded: false,
    attempted: 0,
    recovered: 0,
    userVisible: 0,
    unknown: 0,
    perThousand: null,
    byDay: [],
  },
  scan: scanStatus,
};

const seriesPayload: SeriesResponse = {
  timezone: 'UTC',
  days: 28,
  points: [],
  refusals: { recorded: false, days: [] },
};

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

function mountDashboard(handler: (url: string) => FetchResponse) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      return handler(url);
    }),
  );
  vi.stubGlobal('EventSource', FakeEventSource);
  // happy-dom does not expose localStorage in this environment.
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
  });
  const target = document.createElement('div');
  document.body.append(target);
  const component = mount(Dashboard, { target });
  return { calls, component, target };
}

function clickRange(target: ParentNode, label: string) {
  const button = [...target.querySelectorAll<HTMLButtonElement>('.range-control button')].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing range button: ${label}`);
  flushSync(() => button.click());
}

describe('selected-day background refresh', () => {
  it('retains the explicit day and hero through a transient missing series point', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(DashboardRefreshHarness, { target });

    try {
      click(target, 'load-r0');
      click(target, 'select-aug13');
      expect(target.querySelector('[data-testid="selected-date"]')?.textContent).toBe('2026-08-13');
      expect(target.textContent).toContain('64');

      click(target, 'refresh-r1');
      expect(target.querySelector('[data-testid="selected-date"]')?.textContent).toBe('2026-08-13');
      expect(target.textContent).toContain('64');
      expect(target.textContent).toContain('Updating in the background');
      expect(target.textContent).not.toContain('Loading this day');
      expect(target.textContent).not.toContain('Today selected');

      click(target, 'refresh-r2');
      expect(target.querySelector('[data-testid="selected-date"]')?.textContent).toBe('2026-08-13');
      expect(target.textContent).toContain('65');
      expect(target.textContent).not.toContain('Loading this day');

      click(target, 'range-change');
      expect(target.querySelector('[data-testid="selected-date"]')?.textContent).toBe('2026-08-14');
      expect(target.textContent).toContain('Loading this day');
    } finally {
      unmount(component);
      target.remove();
    }
  });

  it('selects Today when an ordinary revision supplies the first available data', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(DashboardRefreshHarness, { target });

    try {
      click(target, 'load-empty');
      expect(target.querySelector('[data-testid="selected-date"]')?.textContent).toBe('');
      expect(target.textContent).not.toContain('Loading this day');

      click(target, 'load-first-data');
      expect(target.querySelector('[data-testid="selected-date"]')?.textContent).toBe('2026-08-14');
      expect(target.textContent).toContain('70');
      expect(target.textContent).not.toContain('Loading this day');
    } finally {
      unmount(component);
      target.remove();
    }
  });
});

describe('session expiry', () => {
  it('replaces the offline error with the session-expired banner when a request answers 401', async () => {
    const { calls, component, target } = mountDashboard(() => statusResponse(401));

    try {
      await settle();
      expect(calls).toContain('/api/v1/overview');
      expect(target.textContent).toContain(
        'Session expired — reopen the private dashboard URL printed by the CLI.',
      );
      expect(target.textContent).not.toContain('We lost the local signal');
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(FakeEventSource.instances[0]?.closed).toBe(true);
    } finally {
      unmount(component);
      target.remove();
      vi.unstubAllGlobals();
      FakeEventSource.instances = [];
    }
  });

  it('issues no further requests and keeps the event stream closed after expiry', async () => {
    let denySession = false;
    const { calls, component, target } = mountDashboard((url) => {
      if (url.startsWith('/api/v1/overview'))
        return denySession ? statusResponse(401) : jsonResponse(overviewPayload);
      if (url.startsWith('/api/v1/series')) return jsonResponse(seriesPayload);
      if (url.startsWith('/api/v1/quota')) return statusResponse(404);
      if (url.startsWith('/api/v1/data-quality')) return jsonResponse({ rows: 10, invalidRows: 0 });
      return statusResponse(404);
    });

    try {
      await settle();
      expect(target.textContent).toContain('Your first reading will appear here');
      expect(target.textContent).not.toContain('Session expired');

      denySession = true;
      clickRange(target, '90d');
      await settle();
      expect(target.textContent).toContain(
        'Session expired — reopen the private dashboard URL printed by the CLI.',
      );

      const requestsAfterExpiry = calls.length;
      const source = FakeEventSource.instances[0];
      if (!source) throw new Error('Missing event source');
      source.emitScan({ ...scanStatus, revision: 8 });
      clickRange(target, '1y');
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(calls.length).toBe(requestsAfterExpiry);
      expect(source.closed).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(1);
    } finally {
      unmount(component);
      target.remove();
      vi.unstubAllGlobals();
      FakeEventSource.instances = [];
    }
  });
});
