import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ recordQuotaSample: vi.fn() }));

vi.mock('$lib/server/runtime', () => ({ getRuntime: () => runtime }));

import { POST } from '../../src/routes/api/v1/statusline/+server';

const fiveHour = { usedPercentage: 3, resetsAt: '2026-08-14T15:00:00.000Z' };

function request(body: unknown) {
  return POST({
    request: new Request('http://127.0.0.1:4173/api/v1/statusline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never);
}

describe('statusline API', () => {
  beforeEach(() => {
    runtime.recordQuotaSample.mockReset();
  });

  it('accepts a sample with a trimmed model id', async () => {
    const response = await request({ fiveHour, model: '  claude-fable-5  ' });
    expect(response.status).toBe(202);
    expect(runtime.recordQuotaSample).toHaveBeenCalledWith(
      expect.objectContaining({ fiveHour, model: 'claude-fable-5' }),
    );
  });

  it('caps an overlong model id and drops non-string or blank ids', async () => {
    await request({ fiveHour, model: 'x'.repeat(80) });
    expect(runtime.recordQuotaSample).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'x'.repeat(64) }),
    );

    for (const model of [5, '', '   ', null, { id: 'claude-fable-5' }]) {
      runtime.recordQuotaSample.mockClear();
      await request({ fiveHour, model });
      const sample = runtime.recordQuotaSample.mock.calls[0][0];
      expect(sample).not.toHaveProperty('model');
    }
  });

  it('still accepts a sample without any model field', async () => {
    const response = await request({ fiveHour });
    expect(response.status).toBe(202);
    const sample = runtime.recordQuotaSample.mock.calls[0][0];
    expect(sample).not.toHaveProperty('model');
    expect(sample.fiveHour).toEqual(fiveHour);
  });

  it('rejects bodies without a valid rate-limit window', async () => {
    await expect(request({ model: 'claude-fable-5' })).rejects.toMatchObject({
      status: 400,
      body: { message: 'No valid rate-limit window supplied' },
    });
    expect(runtime.recordQuotaSample).not.toHaveBeenCalled();
  });
});
