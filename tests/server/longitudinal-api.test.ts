import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ longitudinal: vi.fn() }));

vi.mock('$lib/server/runtime', () => ({ getRuntime: () => runtime }));

import { GET } from '../../src/routes/api/v1/longitudinal/+server';

const summary = {
  timezone: 'UTC',
  days: 90,
  startDate: '2026-05-17',
  throughDate: '2026-08-14',
  families: ['opus', 'sonnet'],
  observedDays: 0,
  measuredRequests: 0,
  measuredOutputTokens: 0,
  qualifiedDays: 0,
  comparableRequestCoverage: 0,
  quality: 'insufficient',
  variationPct: null,
  trendPct: null,
  points: [],
  refusalsRecorded: false,
  refusals: [],
};

function request(url: string) {
  return GET({ url: new URL(url) } as never);
}

describe('longitudinal API', () => {
  beforeEach(() => {
    runtime.longitudinal.mockReset();
    runtime.longitudinal.mockReturnValue(summary);
  });

  it('passes an allowlisted range and canonical model-family order to analytics', async () => {
    const response = await request(
      'http://127.0.0.1/api/v1/longitudinal?days=90&families=sonnet,opus',
    );
    expect(runtime.longitudinal).toHaveBeenCalledWith(90, ['opus', 'sonnet']);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual(summary);
  });

  it('rejects unknown ranges, unknown families, and an empty selection', async () => {
    const expectBadRequest = async (url: string, message: string) => {
      try {
        await request(url);
        throw new Error('Expected the route to reject the request.');
      } catch (cause) {
        expect(cause).toMatchObject({ status: 400, body: { message } });
      }
    };
    await expectBadRequest(
      'http://127.0.0.1/api/v1/longitudinal?days=30&families=sonnet',
      'days must be 28, 90, or 365',
    );
    await expectBadRequest(
      'http://127.0.0.1/api/v1/longitudinal?days=90&families=sonnet,private-model',
      'families must contain one or more known model families',
    );
    await expectBadRequest(
      'http://127.0.0.1/api/v1/longitudinal?days=90',
      'families must contain one or more known model families',
    );
    expect(runtime.longitudinal).not.toHaveBeenCalled();
  });
});
