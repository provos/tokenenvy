// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DayDetailResponse,
  ModelFamily,
  OverviewResponse,
  QuotaResponse,
  ScanStatus,
  SeriesResponse,
} from '../../src/lib/types';
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
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  closed = false;
  readyState = FakeEventSource.OPEN;
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
    this.readyState = FakeEventSource.CLOSED;
  }

  emitScan(status: ScanStatus) {
    const data = JSON.stringify(status);
    for (const handler of this.scanHandlers) handler({ data });
  }

  /** A non-200 reply closes an EventSource for good instead of reconnecting. */
  failConnection() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }

  /** A dropped connection keeps the stream alive while the browser retries. */
  dropConnection() {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.();
  }
}

function jsonResponse(payload: unknown | Promise<unknown>): FetchResponse {
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
      failures: {
        recorded: false,
        attempted: 0,
        overloaded: 0,
        serverError: 0,
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
  failures: {
    recorded: false,
    attempted: 0,
    overloaded: 0,
    serverError: 0,
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
  failures: { recorded: false, days: [] },
};

const quotaPayload: QuotaResponse = {
  available: true,
  source: 'statusline',
  fiveHour: null,
  sevenDay: {
    usedPercentage: 42,
    observedAt: '2026-08-14T12:00:00.000Z',
    resetsAt: '2026-08-21T12:00:00.000Z',
    stale: false,
  },
  models: [
    {
      model: 'claude-fable-5',
      fiveHour: {
        usedPercentage: 3,
        observedAt: '2026-08-14T12:00:00.000Z',
        resetsAt: '2026-08-14T15:00:00.000Z',
        stale: false,
      },
      sevenDay: {
        usedPercentage: 40,
        observedAt: '2026-08-14T12:00:00.000Z',
        resetsAt: '2026-08-21T12:00:00.000Z',
        stale: false,
      },
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function scanAt(revision: number): ScanStatus {
  return { ...scanStatus, revision };
}

function measuredOverview(revision: number, families: ModelFamily[]): OverviewResponse {
  return {
    ...overviewPayload,
    headline: {
      count: 12,
      sessions: 3,
      median: 64,
      q1: 52,
      q3: 76,
      p10: 44,
      p90: 90,
      ciLow: 59,
      ciHigh: 70,
      outputTokens: 4_200,
      provisional: 0,
    },
    models: families.map((family, index) => ({
      family,
      count: 12 - index,
      sessions: 3,
      median: 64 + index,
      q1: 52,
      q3: 76,
      p10: 44,
      p90: 90,
      ciLow: 59,
      ciHigh: 70,
      outputTokens: 4_200 - index * 200,
      share: 1 / families.length,
    })),
    scan: scanAt(revision),
  };
}

function measuredSeries(families: ModelFamily[], days = 28): SeriesResponse {
  return {
    ...seriesPayload,
    days,
    points: families.map((family, index) => ({
      date: overviewPayload.today,
      family,
      count: 12 - index,
      sessions: 3,
      median: 64 + index,
      q1: 52,
      q3: 76,
      p10: 44,
      p90: 90,
      ciLow: 59,
      ciHigh: 70,
      outputTokens: 4_200 - index * 200,
      provisional: 0,
    })),
  };
}

function measuredDay(families: ModelFamily[]): DayDetailResponse {
  return {
    date: overviewPayload.today,
    timezone: 'UTC',
    summary: {
      count: 12,
      sessions: 3,
      median: 64,
      q1: 52,
      q3: 76,
      p10: 44,
      p90: 90,
      ciLow: 59,
      ciHigh: 70,
      outputTokens: 4_200,
    },
    speedIndex: emptySpeedIndex,
    models: measuredOverview(7, families).models,
    histogram: [{ lower: 40, upper: 80, count: 12 }],
    hourly: [],
    exclusions: {},
  };
}

async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  await tick();
}

async function settlePromises() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
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
  flushSync();
  return { calls, component, target };
}

function rangeButton(target: ParentNode, label: string): HTMLButtonElement {
  const button = [...target.querySelectorAll<HTMLButtonElement>('.range-control button')].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing range button: ${label}`);
  return button;
}

function clickRange(target: ParentNode, label: string) {
  const button = rangeButton(target, label);
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

describe('live dashboard refresh scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it('starts a scheduled refresh on time even when newer scan events keep arriving', async () => {
    let overviewCalls = 0;
    const { component, target } = mountDashboard((url) => {
      if (url.startsWith('/api/v1/overview')) {
        overviewCalls += 1;
        return jsonResponse(measuredOverview(overviewCalls === 1 ? 7 : 9, ['opus']));
      }
      if (url.startsWith('/api/v1/series')) return jsonResponse(measuredSeries(['opus']));
      if (url.startsWith('/api/v1/days/')) return jsonResponse(measuredDay(['opus']));
      if (url.startsWith('/api/v1/quota')) return statusResponse(404);
      if (url.startsWith('/api/v1/data-quality')) return jsonResponse({ rows: 10, invalidRows: 0 });
      return statusResponse(404);
    });

    try {
      await settle();
      expect(overviewCalls).toBe(1);
      const source = FakeEventSource.instances[0];
      if (!source) throw new Error('Missing event source');

      source.emitScan(scanAt(8));
      await settle(200);
      source.emitScan(scanAt(9));
      await settle(149);
      expect(overviewCalls).toBe(1);

      // The second event must not push the original 350ms deadline out to 550ms.
      await settle(1);
      expect(overviewCalls).toBe(2);
    } finally {
      unmount(component);
      target.remove();
    }
  });

  it('coalesces overlapping dashboard and same-day work, then paints Sonnet without a reload', async () => {
    const dashboardRevision8 = deferred<OverviewResponse>();
    const dayRevision8 = deferred<DayDetailResponse>();
    let overviewCalls = 0;
    let dayCalls = 0;
    const { component, target } = mountDashboard((url) => {
      if (url.startsWith('/api/v1/overview')) {
        overviewCalls += 1;
        if (overviewCalls === 1) return jsonResponse(measuredOverview(7, ['opus', 'fable']));
        if (overviewCalls === 2) return jsonResponse(dashboardRevision8.promise);
        return jsonResponse(measuredOverview(10, ['sonnet']));
      }
      if (url.startsWith('/api/v1/series')) {
        return jsonResponse(measuredSeries(overviewCalls >= 3 ? ['sonnet'] : ['opus', 'fable']));
      }
      if (url.startsWith('/api/v1/days/')) {
        dayCalls += 1;
        if (dayCalls === 1) return jsonResponse(measuredDay(['opus', 'fable']));
        if (dayCalls === 2) return jsonResponse(dayRevision8.promise);
        return jsonResponse(measuredDay(['sonnet']));
      }
      if (url.startsWith('/api/v1/quota')) return statusResponse(404);
      if (url.startsWith('/api/v1/data-quality')) return jsonResponse({ rows: 10, invalidRows: 0 });
      return statusResponse(404);
    });

    try {
      await settle();
      expect(dayCalls).toBe(1);
      expect(target.querySelector('.model-list')?.textContent?.toLowerCase()).toContain('opus');
      const source = FakeEventSource.instances[0];
      if (!source) throw new Error('Missing event source');

      source.emitScan(scanAt(8));
      await settle(350);
      expect(overviewCalls).toBe(2);

      source.emitScan(scanAt(9));
      source.emitScan(scanAt(10));
      await settle(1_000);
      expect(overviewCalls).toBe(2);
      expect(target.querySelector('.model-list')?.textContent?.toLowerCase()).toContain('opus');

      dashboardRevision8.resolve(measuredOverview(8, ['opus', 'fable']));
      await settle(350);
      expect(overviewCalls).toBe(3);
      expect(dayCalls).toBe(2);

      // The latest dashboard may finish while the older same-date detail is still pending.
      // It must queue one catch-up instead of invalidating that response repeatedly.
      await settle(1_000);
      expect(dayCalls).toBe(2);
      dayRevision8.resolve(measuredDay(['opus', 'fable']));
      await settle(350);

      expect(dayCalls).toBe(3);
      const modelList = target.querySelector('.model-list')?.textContent?.toLowerCase();
      expect(modelList).toContain('sonnet');
      expect(modelList).not.toContain('opus');
      expect(FakeEventSource.instances).toHaveLength(1);
    } finally {
      unmount(component);
      target.remove();
    }
  });

  it('queues a range choice behind a background refresh and keeps its busy state', async () => {
    const dashboardRevision8 = deferred<OverviewResponse>();
    let overviewCalls = 0;
    const seriesCalls: string[] = [];
    const { component, target } = mountDashboard((url) => {
      if (url.startsWith('/api/v1/overview')) {
        overviewCalls += 1;
        if (overviewCalls === 1) return jsonResponse(measuredOverview(7, ['opus']));
        if (overviewCalls === 2) return jsonResponse(dashboardRevision8.promise);
        return jsonResponse(measuredOverview(8, ['opus']));
      }
      if (url.startsWith('/api/v1/series')) {
        seriesCalls.push(url);
        return jsonResponse(measuredSeries(['opus'], url.includes('days=90') ? 90 : 28));
      }
      if (url.startsWith('/api/v1/days/')) return jsonResponse(measuredDay(['opus']));
      if (url.startsWith('/api/v1/quota')) return statusResponse(404);
      if (url.startsWith('/api/v1/data-quality')) return jsonResponse({ rows: 10, invalidRows: 0 });
      return statusResponse(404);
    });

    try {
      await settle();
      const source = FakeEventSource.instances[0];
      if (!source) throw new Error('Missing event source');
      source.emitScan(scanAt(8));
      await settle(350);
      expect(overviewCalls).toBe(2);

      clickRange(target, '90d');
      expect(overviewCalls).toBe(2);
      expect(rangeButton(target, '90d').getAttribute('aria-busy')).toBe('true');
      expect(rangeButton(target, '90d').disabled).toBe(true);

      dashboardRevision8.resolve(measuredOverview(8, ['opus']));
      await settle(350);

      expect(overviewCalls).toBe(3);
      expect(seriesCalls.at(-1)).toContain('days=90');
      expect(rangeButton(target, '90d').getAttribute('aria-pressed')).toBe('true');
      expect(rangeButton(target, '90d').getAttribute('aria-busy')).toBe('false');
      expect(rangeButton(target, '90d').disabled).toBe(false);
    } finally {
      unmount(component);
      target.remove();
    }
  });

  it('drops a queued follow-up when the dashboard is destroyed', async () => {
    const dashboardRevision8 = deferred<OverviewResponse>();
    let overviewCalls = 0;
    const { component, target } = mountDashboard((url) => {
      if (url.startsWith('/api/v1/overview')) {
        overviewCalls += 1;
        return jsonResponse(
          overviewCalls === 1 ? measuredOverview(7, ['opus']) : dashboardRevision8.promise,
        );
      }
      if (url.startsWith('/api/v1/series')) return jsonResponse(measuredSeries(['opus']));
      if (url.startsWith('/api/v1/days/')) return jsonResponse(measuredDay(['opus']));
      if (url.startsWith('/api/v1/quota')) return statusResponse(404);
      if (url.startsWith('/api/v1/data-quality')) return jsonResponse({ rows: 10, invalidRows: 0 });
      return statusResponse(404);
    });

    await settle();
    const source = FakeEventSource.instances[0];
    if (!source) throw new Error('Missing event source');
    source.emitScan(scanAt(8));
    await settle(350);
    source.emitScan(scanAt(9));
    expect(overviewCalls).toBe(2);

    unmount(component);
    target.remove();
    dashboardRevision8.resolve(measuredOverview(8, ['opus']));
    await settle(1_000);
    expect(overviewCalls).toBe(2);
  });

  it('does not commit an in-flight quota-only refresh after teardown', async () => {
    const nextQuota = deferred<QuotaResponse>();
    let quotaCalls = 0;
    const { calls, component, target } = mountDashboard((url) => {
      if (url.startsWith('/api/v1/overview')) return jsonResponse(measuredOverview(7, ['opus']));
      if (url.startsWith('/api/v1/series')) return jsonResponse(measuredSeries(['opus']));
      if (url.startsWith('/api/v1/days/')) return jsonResponse(measuredDay(['opus']));
      if (url.startsWith('/api/v1/quota')) {
        quotaCalls += 1;
        return quotaCalls === 1 ? statusResponse(404) : jsonResponse(nextQuota.promise);
      }
      if (url.startsWith('/api/v1/data-quality')) return jsonResponse({ rows: 10, invalidRows: 0 });
      return statusResponse(404);
    });

    await settle();
    const source = FakeEventSource.instances[0];
    if (!source) throw new Error('Missing event source');
    source.emitScan(scanAt(7));
    await settle(350);
    expect(quotaCalls).toBe(2);

    unmount(component);
    target.remove();
    const requestsAtTeardown = calls.length;
    // A successful quota commit updates quotaClock from Date.now. Spying after
    // teardown makes that otherwise-internal stale commit observable.
    const now = vi.spyOn(Date, 'now');
    try {
      nextQuota.resolve(quotaPayload);
      await settlePromises();
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
    await settle(1_000);
    expect(calls).toHaveLength(requestsAtTeardown);
    expect(source.closed).toBe(true);
  });
});

describe('session expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

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
    }
  });

  it('does not commit analytics when the optional quota request expires the session', async () => {
    const nextOverview = deferred<OverviewResponse>();
    const nextSeries = deferred<SeriesResponse>();
    const nextQuality = deferred<{ rows: number; invalidRows: number }>();
    let dayCalls = 0;
    const { calls, component, target } = mountDashboard((url) => {
      if (url.startsWith('/api/v1/overview')) return jsonResponse(nextOverview.promise);
      if (url.startsWith('/api/v1/series')) return jsonResponse(nextSeries.promise);
      if (url.startsWith('/api/v1/quota')) return statusResponse(401);
      if (url.startsWith('/api/v1/data-quality')) return jsonResponse(nextQuality.promise);
      if (url.startsWith('/api/v1/days/')) {
        dayCalls += 1;
        return jsonResponse(measuredDay(['sonnet']));
      }
      return statusResponse(404);
    });

    try {
      await settle();
      expect(target.textContent).toContain(
        'Session expired — reopen the private dashboard URL printed by the CLI.',
      );
      expect(FakeEventSource.instances[0]?.closed).toBe(true);
      expect(dayCalls).toBe(0);

      // A dashboard batch commit also advances quotaClock. Observe that side
      // effect because the expired-session banner intentionally hides analytics.
      const now = vi.spyOn(Date, 'now');
      try {
        nextOverview.resolve(measuredOverview(7, ['sonnet']));
        nextSeries.resolve(measuredSeries(['sonnet']));
        nextQuality.resolve({ rows: 10, invalidRows: 0 });
        await settlePromises();
        expect(now).not.toHaveBeenCalled();
      } finally {
        now.mockRestore();
      }

      expect(dayCalls).toBe(0);
      expect(target.textContent).toContain(
        'Session expired — reopen the private dashboard URL printed by the CLI.',
      );
      expect(target.textContent).not.toContain('sonnet');
      expect(calls.filter((url) => url.startsWith('/api/v1/days/'))).toHaveLength(0);
    } finally {
      unmount(component);
      target.remove();
    }
  });

  it('locks the header controls and issues no further requests after expiry', async () => {
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
      expect(target.textContent).toContain('Live');

      denySession = true;
      clickRange(target, '90d');
      await settle();
      expect(target.textContent).toContain(
        'Session expired — reopen the private dashboard URL printed by the CLI.',
      );

      // A dead session must not leave a live-looking header behind the banner.
      expect(target.textContent).not.toContain('Live');
      expect(rangeButton(target, '1y').disabled).toBe(true);
      expect(target.querySelector<HTMLButtonElement>('.share-button')?.disabled).toBe(true);

      const requestsAfterExpiry = calls.length;
      const source = FakeEventSource.instances[0];
      if (!source) throw new Error('Missing event source');
      source.emitScan({ ...scanStatus, revision: 8 });
      clickRange(target, '1y');
      await settle(450);
      expect(calls.length).toBe(requestsAfterExpiry);
      expect(source.closed).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(1);
    } finally {
      unmount(component);
      target.remove();
    }
  });

  it('probes once when the event stream closes for good and surfaces the expiry', async () => {
    let denySession = false;
    const { calls, component, target } = mountDashboard((url) => {
      if (denySession) return statusResponse(401);
      if (url.startsWith('/api/v1/overview')) return jsonResponse(overviewPayload);
      if (url.startsWith('/api/v1/series')) return jsonResponse(seriesPayload);
      if (url.startsWith('/api/v1/quota')) return statusResponse(404);
      if (url.startsWith('/api/v1/data-quality')) return jsonResponse({ rows: 10, invalidRows: 0 });
      return statusResponse(404);
    });

    try {
      await settle();
      const source = FakeEventSource.instances[0];
      if (!source) throw new Error('Missing event source');

      // A retrying stream is not evidence of an expired session.
      const requestsBeforeDrop = calls.length;
      source.dropConnection();
      await settle();
      expect(calls.length).toBe(requestsBeforeDrop);
      expect(target.textContent).not.toContain('Session expired');

      // A stream the browser closed for good is, so one probe reports the verdict.
      denySession = true;
      source.failConnection();
      await settle();
      expect(calls.length).toBe(requestsBeforeDrop + 1);
      expect(target.textContent).toContain(
        'Session expired — reopen the private dashboard URL printed by the CLI.',
      );

      source.failConnection();
      await settle(450);
      expect(calls.length).toBe(requestsBeforeDrop + 1);
    } finally {
      unmount(component);
      target.remove();
    }
  });
});
