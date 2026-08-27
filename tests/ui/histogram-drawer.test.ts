import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import HistogramDrawer from '../../src/lib/components/HistogramDrawer.svelte';
import type { ShareFailureCounts, ShareRefusalCounts } from '../../src/lib/components/share';
import type { DayDetailResponse } from '../../src/lib/types';

const detail: DayDetailResponse = {
  date: '2026-08-14',
  timezone: 'America/Los_Angeles',
  summary: {
    count: 12,
    sessions: 3,
    median: 64,
    q1: 50,
    q3: 75,
    p10: 42,
    p90: 90,
    ciLow: 58,
    ciHigh: 70,
    outputTokens: 4_200,
  },
  speedIndex: {
    value: 108,
    ciLow: 102,
    ciHigh: 114,
    percentile: 70,
    eligible: true,
    reason: null,
  },
  models: [],
  histogram: [],
  hourly: [],
  exclusions: {},
};

const noRefusals: ShareRefusalCounts = {
  recorded: true,
  attempted: 0,
  recovered: 0,
  userVisible: 0,
};
const noFailures: ShareFailureCounts = {
  recorded: true,
  attempted: 0,
  overloaded: 0,
  serverError: 0,
};

interface DrawerProps {
  detail: DayDetailResponse;
  refusals: ShareRefusalCounts;
  failures: ShareFailureCounts;
}

/** Renders the drawer open on the shared day, overriding only what a case cares about. */
function drawer(props: Partial<DrawerProps> = {}): string {
  return render(HistogramDrawer, {
    props: {
      open: true,
      loading: false,
      detail,
      refusals: noRefusals,
      failures: noFailures,
      onclose: () => undefined,
      ...props,
    },
  }).body;
}

describe('daily detail refusals', () => {
  it('shows selected-day refusal outcomes and their lower-bound scope', () => {
    const body = drawer({
      refusals: { recorded: true, attempted: 6, recovered: 2, userVisible: 1 },
    });

    expect(body).toContain('Refusals for this day');
    expect(body).toContain('>6<');
    expect(body).toContain('>2<');
    expect(body).toContain('>1<');
    expect(body).toContain('>3<');
    expect(body).toContain('Explicit transcript signals only; these counts are a lower bound.');
  });

  it('explains why an eligible point estimate has no confidence interval', () => {
    const body = drawer({
      detail: { ...detail, speedIndex: { ...detail.speedIndex, ciLow: null, ciHigh: null } },
    });

    expect(body).toContain(
      'Point estimate available. Confidence interval requires five independent sessions.',
    );
  });
});

describe('daily detail failures', () => {
  it('reports the day’s failures on their own axis beside refusals', () => {
    const body = drawer({
      refusals: { recorded: true, attempted: 6, recovered: 2, userVisible: 1 },
      failures: { recorded: true, attempted: 10, overloaded: 7, serverError: 3 },
    });

    expect(body).toContain('Interruptions on this day');
    expect(body).toContain('Platform failures for this day');
    expect(body).toContain('the model would not');
    expect(body).toContain('the service could not');
    expect(body).toContain('>10<');
    expect(body).toContain('>7<');
    expect(body).toContain('>3<');
    expect(body).toContain('failed calls');
    expect(body).toContain('overloaded (529)');
    expect(body).toContain('server fault');
    // The two axes are reported, never summed: 6 refusals and 10 failures must
    // not become a 16 anywhere on the panel.
    expect(body).not.toContain('>16<');
  });

  it('names both units when the day also excluded requests for api_error', () => {
    const body = drawer({
      detail: { ...detail, exclusions: { api_error: 9 } },
      failures: { recorded: true, attempted: 10, overloaded: 7, serverError: 3 },
    });

    // Event-level failures and request-level exclusions legitimately differ, so
    // both stay on screen with their units spelled out.
    expect(body).toContain('9 requests excluded');
    expect(body).toContain('requests a failed call left unmeasured');
    expect(body).toContain('a row carrying no request id never became one');
  });

  it('explains incomplete and completion-unknown request exclusions', () => {
    const body = drawer({
      detail: {
        ...detail,
        exclusions: { incomplete_response: 7, completion_unknown: 2 },
      },
    });

    expect(body).toContain('9 requests excluded');
    expect(body).toContain('stream ended without a terminal stop');
    expect(body).toContain('response has no trustworthy completion signal');
  });

  it('says so plainly when failures were recorded but none happened', () => {
    const body = drawer();

    expect(body).toContain('No failed calls on this day.');
    expect(body).toContain('No refusal signals on this day.');
    // A quiet day grows no headline zero and no empty outcome cells.
    expect(body).not.toContain('failure-grid');
    expect(body).not.toContain('refusal-total');
    expect(body).not.toContain('Counted per error row');
  });

  it('distinguishes an unrecorded failure axis from a quiet one', () => {
    const body = drawer({
      refusals: { ...noRefusals, recorded: false },
      failures: { ...noFailures, recorded: false },
    });

    expect(body).toContain('This log format does not record API transport failures.');
    expect(body).toContain('This log format does not expose explicit classifier outcomes.');
    expect(body).not.toContain('No failed calls on this day.');
  });
});
