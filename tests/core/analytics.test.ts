import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Analytics } from '../../src/lib/core/analytics';
import { Database } from '../../src/lib/server/database';
import { Scanner } from '../../src/lib/server/scanner';

const dirs: string[] = [];
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true });
});

const row = (value: unknown) => `${JSON.stringify(value)}\n`;

async function fixture(events: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), 'speedometer-analytics-'));
  dirs.push(directory);
  await writeFile(join(directory, 'events.jsonl'), events.map(row).join(''));
  const database = new Database({ path: ':memory:', hmacKey: 'analytics-key' });
  const scanner = new Scanner({ roots: [directory], database, chunkSize: 11 });
  await scanner.scanAll();
  return { database, analytics: new Analytics(database) };
}

function insertRequest(
  database: Database,
  options: {
    id: string;
    sessionId: string;
    date: string;
    outputTokens: number;
    family: 'opus' | 'sonnet' | 'fable' | 'haiku' | 'other';
    stratum: number;
    tokensPerSecond: number;
    provisional?: boolean;
  },
) {
  const finishedAt = Date.parse(`${options.date}T12:00:00Z`);
  database.db
    .prepare(
      `
      INSERT INTO requests(
        request_id, session_id, started_at, finished_at, duration_ms, output_tokens,
        input_tokens, cache_read_tokens, cache_creation_tokens, family, stratum,
        tokens_per_second, provisional, quality_reason
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, NULL)
    `,
    )
    .run(
      options.id,
      options.sessionId,
      finishedAt - 1_000,
      finishedAt,
      1_000,
      options.outputTokens,
      options.family,
      options.stratum,
      options.tokensPerSecond,
      options.provisional ? 1 : 0,
    );
}

describe('analytics', () => {
  it('groups timestamps by IANA timezone across a DST transition', async () => {
    const { database, analytics } = await fixture([
      { type: 'user', uuid: 'u1', sessionId: 's1', timestamp: '2024-03-10T09:29:59.000Z' },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'r1',
        sessionId: 's1',
        timestamp: '2024-03-10T09:30:00.000Z',
        message: { model: 'sonnet', usage: { output_tokens: 10 } },
      },
      { type: 'user', uuid: 'u2', sessionId: 's2', timestamp: '2024-03-10T10:29:59.000Z' },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        requestId: 'r2',
        sessionId: 's2',
        timestamp: '2024-03-10T10:30:00.000Z',
        message: { model: 'opus', usage: { output_tokens: 20 } },
      },
    ]);
    const detail = analytics.day('2024-03-10', 'America/Los_Angeles');
    expect(detail?.summary.count).toBe(2);
    expect(detail?.hourly[1].count).toBe(1);
    expect(detail?.hourly[2].count).toBe(0);
    expect(detail?.hourly[3].count).toBe(1);
    database.close();
  });

  it('reports explicit classifier outcomes without explanations', async () => {
    const { database, analytics } = await fixture([
      {
        type: 'system',
        subtype: 'model_refusal_fallback',
        uuid: 'f1',
        requestId: 'r1',
        sessionId: 's1',
        timestamp: '2026-08-12T02:02:34.379Z',
        apiRefusalCategory: 'cyber',
        apiRefusalExplanation: 'PRIVATE',
        fallbackModel: 'claude-opus-5',
      },
      {
        type: 'system',
        subtype: 'model_refusal_no_fallback',
        uuid: 'f2',
        requestId: 'r2',
        sessionId: 's2',
        timestamp: '2026-08-13T02:02:34.379Z',
        apiRefusalCategory: 'cyber',
        apiRefusalExplanation: 'PRIVATE',
      },
      {
        type: 'system',
        uuid: 'f3',
        requestId: 'r3',
        sessionId: 's3',
        timestamp: '2026-08-13T03:00:00Z',
        apiRefusalCategory: 'policy',
        apiRefusalExplanation: 'PRIVATE',
      },
    ]);
    expect(analytics.refusals('UTC')).toMatchObject({
      recorded: true,
      attempted: 3,
      recovered: 1,
      userVisible: 1,
      unknown: 1,
    });
    database.close();
  });

  it('stores local status-line quota samples and marks reset windows stale', async () => {
    const database = new Database({ path: ':memory:', hmacKey: 'quota-key' });
    const analytics = new Analytics(database);
    database.recordQuotaSample({
      observedAt: '2026-08-14T12:00:00Z',
      fiveHour: { usedPercentage: 31.5, resetsAt: '2026-08-14T15:00:00Z' },
      sevenDay: { usedPercentage: 70, resetsAt: '2026-08-18T00:00:00Z' },
    });
    const fresh = analytics.quota(new Date('2026-08-14T12:10:00Z'));
    expect(fresh).toMatchObject({
      available: true,
      source: 'statusline',
      fiveHour: { stale: false },
    });
    expect(analytics.quota(new Date('2026-08-14T15:00:00Z')).fiveHour?.stale).toBe(true);
    database.close();
  });

  it('exposes explicit quality reasons for excluded requests', async () => {
    const { database, analytics } = await fixture([
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'missing',
        requestId: 'r1',
        sessionId: 's1',
        timestamp: '2026-08-14T12:00:01Z',
        message: { model: 'sonnet', usage: { output_tokens: 10 } },
      },
    ]);
    expect(analytics.dataQuality()).toMatchObject({
      requests: 1,
      includedRequests: 0,
      exclusions: { missing_parent: 1 },
    });
    database.close();
  });

  it('returns null when a day has no recorded requests', async () => {
    const database = new Database({ path: ':memory:', hmacKey: 'empty-day-key' });
    expect(new Analytics(database).day('2026-08-14', 'UTC')).toBeNull();
    database.close();
  });

  it('shares request snapshots across endpoints and invalidates them after database changes', async () => {
    const { database, analytics } = await fixture([
      { type: 'user', uuid: 'u1', sessionId: 's1', timestamp: '2026-08-14T11:59:59.000Z' },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'r1',
        sessionId: 's1',
        timestamp: '2026-08-14T12:00:00.000Z',
        message: { model: 'sonnet', usage: { output_tokens: 10 } },
      },
    ]);
    const getRequests = vi.spyOn(database, 'getRequests');
    analytics.overview('UTC', new Date('2026-08-14T18:00:00Z'));
    analytics.series(30, 'UTC', new Date('2026-08-14T18:00:00Z'));
    analytics.day('2026-08-14', 'UTC');
    expect(getRequests).toHaveBeenCalledTimes(1);

    database.rebuildRequests(Date.parse('2026-08-15T00:00:00Z'));
    analytics.series(30, 'UTC', new Date('2026-08-14T18:00:00Z'));
    expect(getRequests).toHaveBeenCalledTimes(2);

    database.retractSources(database.listSourceIds());
    analytics.series(30, 'UTC', new Date('2026-08-14T18:00:00Z'));
    expect(getRequests).toHaveBeenCalledTimes(3);
    database.close();
  });

  it('excludes provisional requests from analytics while reporting their count', () => {
    const database = new Database({ path: ':memory:', hmacKey: 'provisional-key' });
    insertRequest(database, {
      id: 'complete',
      sessionId: 'complete-session',
      date: '2026-08-14',
      outputTokens: 20,
      family: 'sonnet',
      stratum: 0,
      tokensPerSecond: 10,
    });
    insertRequest(database, {
      id: 'provisional',
      sessionId: 'provisional-session',
      date: '2026-08-14',
      outputTokens: 100,
      family: 'sonnet',
      stratum: 1,
      tokensPerSecond: 100,
      provisional: true,
    });

    const analytics = new Analytics(database);
    const overview = analytics.overview('UTC', new Date('2026-08-14T18:00:00Z'));
    expect(overview.headline).toMatchObject({
      count: 1,
      median: 10,
      outputTokens: 20,
      provisional: 1,
    });
    expect(analytics.series(28, 'UTC', new Date('2026-08-14T18:00:00Z')).points).toMatchObject([
      { count: 1, median: 10, outputTokens: 20, provisional: 1 },
    ]);
    expect(analytics.dataQuality()).toMatchObject({
      requests: 2,
      includedRequests: 1,
      exclusions: { provisional: 1 },
    });
    database.close();
  });

  it('rejects an index when most current requests have no comparable stratum', () => {
    const database = new Database({ path: ':memory:', hmacKey: 'coverage-key' });
    for (let index = 0; index < 100; index += 1) {
      insertRequest(database, {
        id: `baseline-${index}`,
        sessionId: `baseline-session-${index % 8}`,
        date: `2026-08-${String(1 + (index % 7)).padStart(2, '0')}`,
        outputTokens: 32,
        family: 'sonnet',
        stratum: 0,
        tokensPerSecond: 10,
      });
    }
    for (let index = 0; index < 20; index += 1) {
      const comparable = index < 10;
      insertRequest(database, {
        id: `current-${index}`,
        sessionId: `current-session-${index % 5}`,
        date: '2026-08-14',
        outputTokens: comparable ? 32 : 2_048,
        family: comparable ? 'sonnet' : 'opus',
        stratum: comparable ? 0 : 3,
        tokensPerSecond: 20,
      });
    }

    const index = new Analytics(database).overview(
      'UTC',
      new Date('2026-08-14T18:00:00Z'),
    ).speedIndex;
    expect(index).toMatchObject({
      eligible: false,
      reason: 'Not enough comparable model and output-size coverage.',
    });
    database.close();
  });

  it('combines stratum ratios with fixed-weight geometric means', () => {
    const database = new Database({ path: ':memory:', hmacKey: 'geometric-key' });
    for (let index = 0; index < 100; index += 1) {
      const firstStratum = index < 50;
      insertRequest(database, {
        id: `baseline-${index}`,
        sessionId: `baseline-session-${index % 8}`,
        date: `2026-08-${String(1 + (index % 7)).padStart(2, '0')}`,
        outputTokens: firstStratum ? 32 : 128,
        family: firstStratum ? 'sonnet' : 'opus',
        stratum: firstStratum ? 0 : 1,
        tokensPerSecond: 10,
      });
    }
    for (let index = 0; index < 20; index += 1) {
      const firstStratum = index < 10;
      insertRequest(database, {
        id: `current-${index}`,
        sessionId: `current-session-${index % 5}`,
        date: '2026-08-14',
        outputTokens: firstStratum ? 32 : 128,
        family: firstStratum ? 'sonnet' : 'opus',
        stratum: firstStratum ? 0 : 1,
        tokensPerSecond: firstStratum ? 20 : 5,
      });
    }

    const index = new Analytics(database).overview(
      'UTC',
      new Date('2026-08-14T18:00:00Z'),
    ).speedIndex;
    expect(index.eligible).toBe(true);
    expect(index.value).toBeCloseTo(100, 8);
    database.close();
  });

  it('builds a deterministic calendar-week recap from completed measurements', () => {
    const database = new Database({ path: ':memory:', hmacKey: 'weekly-recap-key' });
    for (let index = 0; index < 100; index += 1) {
      insertRequest(database, {
        id: `weekly-baseline-${index}`,
        sessionId: `weekly-baseline-session-${index % 8}`,
        date: `2026-08-${String(1 + (index % 7)).padStart(2, '0')}`,
        outputTokens: 32,
        family: 'sonnet',
        stratum: 0,
        tokensPerSecond: 10,
      });
    }
    const days = [
      { date: '2026-08-10', tokensPerSecond: 20 },
      { date: '2026-08-11', tokensPerSecond: 25 },
      { date: '2026-08-12', tokensPerSecond: 30 },
      { date: '2026-08-13', tokensPerSecond: 15 },
      { date: '2026-08-14', tokensPerSecond: 35 },
    ];
    for (const [dayIndex, day] of days.entries()) {
      for (let index = 0; index < 5; index += 1) {
        insertRequest(database, {
          id: `weekly-current-${dayIndex}-${index}`,
          sessionId: `weekly-current-session-${index}`,
          date: day.date,
          outputTokens: 32,
          family: 'sonnet',
          stratum: 0,
          tokensPerSecond: day.tokensPerSecond,
        });
      }
    }

    const recap = new Analytics(database).overview('UTC', new Date('2026-08-14T18:00:00Z')).weekly
      .recap;
    expect(recap).toMatchObject({
      weekStart: '2026-08-10',
      throughDate: '2026-08-14',
      daysObserved: 5,
      observedDates: ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'],
      requestCount: 25,
      sessions: 5,
      median: 25,
      speedIndex: {
        eligible: true,
        value: 250,
        ciLow: null,
        ciHigh: null,
        percentile: null,
      },
      fastestDay: { date: '2026-08-14', median: 35 },
      slowestDay: { date: '2026-08-13', median: 15 },
    });
    expect(recap.models).toMatchObject([
      { family: 'sonnet', requestCount: 25, outputTokens: 800, share: 1 },
    ]);
    database.close();
  });

  it('compares a selected historical day with its own preceding 28-day baseline', () => {
    const database = new Database({ path: ':memory:', hmacKey: 'historical-index-key' });
    for (let index = 0; index < 100; index += 1) {
      insertRequest(database, {
        id: `historical-baseline-${index}`,
        sessionId: `historical-baseline-session-${index % 8}`,
        date: `2026-07-${String(1 + (index % 10)).padStart(2, '0')}`,
        outputTokens: 32,
        family: 'sonnet',
        stratum: 0,
        tokensPerSecond: 10,
      });
    }
    for (let index = 0; index < 20; index += 1) {
      insertRequest(database, {
        id: `historical-current-${index}`,
        sessionId: `historical-current-session-${index % 5}`,
        date: '2026-07-15',
        outputTokens: 32,
        family: 'sonnet',
        stratum: 0,
        tokensPerSecond: 20,
      });
    }

    const detail = new Analytics(database).day('2026-07-15', 'UTC');
    expect(detail?.speedIndex).toMatchObject({ eligible: true, value: 200 });
    database.close();
  });
});
