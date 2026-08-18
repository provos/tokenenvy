import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Analytics } from '../../src/lib/core/analytics';
import { filterRefusalTimeline } from '../../src/lib/components/chart';
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

  it('reads the data-quality summary once for both interruption rates', async () => {
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
    const getDataQuality = vi.spyOn(database, 'getDataQuality');
    const overview = analytics.overview('UTC', new Date('2026-08-14T18:00:00Z'));
    // Refusals and failures share one measured-request denominator.
    expect(getDataQuality).toHaveBeenCalledTimes(1);
    expect(overview.refusals.perThousand).toBe(overview.failures.perThousand);
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
    expect(index.ciLow).not.toBeNull();
    expect(index.ciHigh).not.toBeNull();
    database.close();
  });

  it('keeps the point estimate eligible when fewer than five sessions prevent an interval', () => {
    const database = new Database({ path: ':memory:', hmacKey: 'point-estimate-key' });
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
      insertRequest(database, {
        id: `current-${index}`,
        sessionId: 'one-long-session',
        date: '2026-08-14',
        outputTokens: 32,
        family: 'sonnet',
        stratum: 0,
        tokensPerSecond: 20,
      });
    }

    const index = new Analytics(database).overview(
      'UTC',
      new Date('2026-08-14T18:00:00Z'),
    ).speedIndex;
    expect(index).toMatchObject({
      eligible: true,
      value: 200,
      ciLow: null,
      ciHigh: null,
      percentile: 100,
      reason: null,
    });
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
    const refusalInsert = database.db.prepare(`
      INSERT INTO events(event_id, request_id, session_id, timestamp_ms, type, refusal_outcome)
      VALUES (?, ?, ?, ?, 'system', ?)
    `);
    refusalInsert.run(
      'weekly-recovered',
      'weekly-current-1-0',
      'weekly-current-session-0',
      Date.parse('2026-08-11T12:00:00Z'),
      'recovered',
    );
    refusalInsert.run(
      'weekly-visible',
      'weekly-current-3-0',
      'weekly-current-session-0',
      Date.parse('2026-08-13T12:00:00Z'),
      'user_visible',
    );
    refusalInsert.run(
      'weekly-unknown',
      null,
      'weekly-unknown-session',
      Date.parse('2026-08-13T13:00:00Z'),
      'unknown',
    );
    refusalInsert.run(
      'prior-week-visible',
      null,
      'prior-week-session',
      Date.parse('2026-08-09T12:00:00Z'),
      'user_visible',
    );

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
      refusals: {
        recorded: true,
        attempted: 3,
        recovered: 1,
        userVisible: 1,
        unknown: 1,
        affectedDates: [
          {
            date: '2026-08-11',
            attempted: 1,
            recovered: 1,
            userVisible: 0,
            unknown: 0,
          },
          {
            date: '2026-08-13',
            attempted: 2,
            recovered: 0,
            userVisible: 1,
            unknown: 1,
          },
        ],
      },
    });
    expect(recap.models).toMatchObject([
      { family: 'sonnet', requestCount: 25, outputTokens: 800, share: 1 },
    ]);
    database.close();
  });

  it('uses local week boundaries while deduplicating archived refusal attribution', () => {
    const database = new Database({ path: ':memory:', hmacKey: 'weekly-refusal-timezone-key' });
    const sundayRefusalAt = Date.parse('2026-08-10T06:30:00Z'); // Sunday 23:30 PDT.
    const mondayRefusalAt = Date.parse('2026-08-10T07:10:00Z'); // Monday 00:10 PDT.
    const archivedAt = Date.parse('2026-08-11T12:00:00Z');

    database.db
      .prepare(
        `
        INSERT INTO request_history(
          request_id, session_id, started_at, finished_at, duration_ms, output_tokens,
          input_tokens, cache_read_tokens, cache_creation_tokens, family, stratum,
          tokens_per_second, provisional, quality_reason, archived_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, 0, NULL, ?, ?)
      `,
      )
      .run(
        'archived-sonnet-request',
        'archived-sonnet-session',
        mondayRefusalAt - 1_000,
        mondayRefusalAt,
        1_000,
        32,
        'sonnet',
        0,
        32,
        archivedAt,
        archivedAt,
      );
    database.db
      .prepare(
        `
        INSERT INTO events(event_id, request_id, session_id, timestamp_ms, type, refusal_outcome)
        VALUES
          ('sunday-refusal', NULL, 'sunday-session', ?, 'system', 'user_visible'),
          ('monday-refusal', 'archived-sonnet-request', 'archived-sonnet-session', ?, 'system', 'recovered')
      `,
      )
      .run(sundayRefusalAt, mondayRefusalAt);
    database.db
      .prepare(
        `
        INSERT INTO refusal_history(
          event_id, request_id, session_id, timestamp_ms, refusal_outcome, archived_at, updated_at
        ) VALUES (
          'monday-refusal', 'archived-sonnet-request', 'archived-sonnet-session', ?,
          'recovered', ?, ?
        )
      `,
      )
      .run(mondayRefusalAt, archivedAt, archivedAt);

    const analytics = new Analytics(database);
    const now = new Date('2026-08-10T18:00:00Z');
    const overview = analytics.overview('America/Los_Angeles', now);
    expect(overview.weekly.recap.refusals).toEqual({
      recorded: true,
      attempted: 1,
      recovered: 1,
      userVisible: 0,
      unknown: 0,
      affectedDates: [
        {
          date: '2026-08-10',
          attempted: 1,
          recovered: 1,
          userVisible: 0,
          unknown: 0,
        },
      ],
    });
    expect(overview.refusals).toMatchObject({
      attempted: 2,
      byDay: [
        { date: '2026-08-09', attempted: 1 },
        { date: '2026-08-10', attempted: 1 },
      ],
    });
    expect(analytics.series(2, 'America/Los_Angeles', now).refusals.days).toMatchObject([
      { date: '2026-08-09', unattributed: { attempted: 1 } },
      {
        date: '2026-08-10',
        families: [{ family: 'sonnet', attempted: 1, recovered: 1 }],
      },
    ]);
    database.close();
  });

  it('builds a filtered longitudinal weather summary with attributed refusal days', () => {
    const database = new Database({ path: ':memory:', hmacKey: 'longitudinal-key' });
    const dates = Array.from({ length: 30 }, (_, day) =>
      new Date(Date.UTC(2026, 6, 16 + day)).toISOString().slice(0, 10),
    );
    for (const [dayIndex, date] of dates.entries()) {
      for (let index = 0; index < 20; index += 1) {
        insertRequest(database, {
          id: `sonnet-${dayIndex}-${index}`,
          sessionId: `sonnet-session-${index % 4}`,
          date,
          outputTokens: 32,
          family: 'sonnet',
          stratum: 0,
          tokensPerSecond: 10,
        });
      }
      for (let index = 0; index < 5; index += 1) {
        insertRequest(database, {
          id: `opus-${dayIndex}-${index}`,
          sessionId: `opus-session-${index % 2}`,
          date,
          outputTokens: 128,
          family: 'opus',
          stratum: 1,
          tokensPerSecond: 100,
        });
      }
    }
    const refusalInsert = database.db.prepare(`
      INSERT INTO events(event_id, request_id, session_id, timestamp_ms, type, refusal_outcome)
      VALUES (?, ?, ?, ?, 'system', ?)
    `);
    refusalInsert.run(
      'sonnet-refusal',
      'sonnet-25-0',
      'sonnet-session-0',
      Date.parse(`${dates[25]}T12:00:00Z`),
      'user_visible',
    );
    refusalInsert.run(
      'opus-refusal',
      'opus-26-0',
      'opus-session-0',
      Date.parse(`${dates[26]}T12:00:00Z`),
      'recovered',
    );
    refusalInsert.run(
      'unattributed-refusal',
      null,
      'unknown-session',
      Date.parse(`${dates[27]}T12:00:00Z`),
      'unknown',
    );

    const analytics = new Analytics(database);
    const now = new Date('2026-08-14T18:00:00Z');
    const summary = analytics.longitudinal(90, ['sonnet'], 'UTC', now);
    expect(summary).toMatchObject({
      families: ['sonnet'],
      observedDays: 30,
      measuredRequests: 600,
      measuredOutputTokens: 19_200,
      qualifiedDays: 30,
      comparableRequestCoverage: 1,
      quality: 'robust',
      variationPct: 0,
      trendPct: 0,
      refusalsRecorded: true,
    });
    expect(summary.points).toHaveLength(30);
    expect(summary.refusals).toEqual([
      {
        date: dates[25],
        selected: { attempted: 1, recovered: 0, userVisible: 1, unknown: 0 },
        unattributed: { attempted: 0, recovered: 0, userVisible: 0, unknown: 0 },
      },
      {
        date: dates[27],
        selected: { attempted: 0, recovered: 0, userVisible: 0, unknown: 0 },
        unattributed: { attempted: 1, recovered: 0, userVisible: 0, unknown: 1 },
      },
    ]);
    expect(analytics.series(90, 'UTC', now).refusals.days).toMatchObject([
      { date: dates[25], families: [{ family: 'sonnet', attempted: 1 }] },
      { date: dates[26], families: [{ family: 'opus', attempted: 1 }] },
      { date: dates[27], unattributed: { attempted: 1 } },
    ]);
    expect(analytics.longitudinal(28, ['sonnet'], 'UTC', now)).toMatchObject({
      observedDays: 28,
      qualifiedDays: 28,
      quality: 'robust',
    });
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

  it('classifies API failures from structured fields and excludes them from throughput', async () => {
    const apiError = (
      uuid: string,
      requestId: string,
      timestamp: string,
      fields: Record<string, unknown>,
    ) => ({
      type: 'assistant',
      uuid,
      parentUuid: 'u1',
      requestId,
      sessionId: 's1',
      timestamp,
      isApiErrorMessage: true,
      ...fields,
      message: {
        model: '<synthetic>',
        usage: { output_tokens: 0 },
        content: [{ type: 'text', text: 'PRIVATE_API_ERROR_TEXT' }],
      },
    });
    const { database, analytics } = await fixture([
      { type: 'user', uuid: 'u1', sessionId: 's1', timestamp: '2026-08-14T12:00:00.000Z' },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'r1',
        sessionId: 's1',
        timestamp: '2026-08-14T12:00:02.000Z',
        message: { model: 'claude-sonnet-4-20250514', usage: { output_tokens: 2 } },
      },
      apiError('e1', 'r1', '2026-08-14T12:00:13.300Z', {
        error: 'server_error',
        apiErrorStatus: 529,
      }),
      { type: 'user', uuid: 'u2', sessionId: 's1', timestamp: '2026-08-14T13:00:00.000Z' },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        requestId: 'r2',
        sessionId: 's1',
        timestamp: '2026-08-14T13:00:02.000Z',
        message: { model: 'claude-sonnet-4-20250514', usage: { output_tokens: 100 } },
      },
      apiError('e3', 'r3', '2026-08-14T14:00:00.000Z', {
        error: 'server_error',
        apiErrorStatus: 500,
      }),
      apiError('e4', 'r4', '2026-08-14T15:00:00.000Z', { error: 'unknown' }),
      apiError('e5', 'r5', '2026-08-14T16:00:00.000Z', { error: 'authentication_failed' }),
      apiError('e6', 'r6', '2026-08-14T17:00:00.000Z', { error: 'invalid_request' }),
      // A 529 outranks an unknown error kind, so this stays platform overload.
      apiError('e7', 'r7', '2026-08-14T18:00:00.000Z', {
        error: 'unknown',
        apiErrorStatus: 529,
      }),
      // A measured status outside 5xx is not a service fault, whatever the CLI
      // called the error kind.
      apiError('e8', 'r8', '2026-08-14T18:30:00.000Z', {
        error: 'server_error',
        apiErrorStatus: 429,
      }),
      apiError('e9', 'r9', '2026-08-14T18:40:00.000Z', {
        error: 'server_error',
        apiErrorStatus: 400,
      }),
    ]);

    expect(
      database.db
        .prepare('SELECT failure_class, COUNT(*) count FROM events GROUP BY failure_class')
        .all(),
    ).toEqual([
      { failure_class: null, count: 4 },
      { failure_class: 'client', count: 3 },
      { failure_class: 'overloaded', count: 2 },
      { failure_class: 'safeguard_block', count: 1 },
      // Only the 500 and the status-less row remain server faults.
      { failure_class: 'server_error', count: 2 },
    ]);
    // A local login fault, a 4xx and an API safeguard block are never service
    // failures.
    expect(analytics.failures('UTC')).toEqual({
      recorded: true,
      attempted: 4,
      overloaded: 2,
      serverError: 2,
      // Rated against measured requests: every other request is excluded as
      // `api_error`, leaving exactly one that was actually measured.
      perThousand: (4 / 1) * 1_000,
      byDay: [{ date: '2026-08-14', attempted: 4, overloaded: 2, serverError: 2 }],
    });
    // The safeguard block is the refusal that reached the user.
    expect(analytics.refusals('UTC')).toMatchObject({
      recorded: true,
      attempted: 1,
      recovered: 0,
      userVisible: 1,
      unknown: 0,
    });
    expect(
      database.getRequests().map(({ qualityReason, tokensPerSecond }) => ({
        qualityReason,
        tokensPerSecond,
      })),
    ).toEqual([
      { qualityReason: 'api_error', tokensPerSecond: null },
      { qualityReason: null, tokensPerSecond: 50 },
      { qualityReason: 'api_error', tokensPerSecond: null },
      { qualityReason: 'api_error', tokensPerSecond: null },
      { qualityReason: 'api_error', tokensPerSecond: null },
      { qualityReason: 'api_error', tokensPerSecond: null },
      { qualityReason: 'api_error', tokensPerSecond: null },
      { qualityReason: 'api_error', tokensPerSecond: null },
      { qualityReason: 'api_error', tokensPerSecond: null },
    ]);
    const detail = analytics.day('2026-08-14', 'UTC');
    expect(detail?.summary.count).toBe(1);
    expect(detail?.exclusions).toEqual({ api_error: 8 });

    const now = new Date('2026-08-14T20:00:00Z');
    expect(analytics.overview('UTC', now).failures).toMatchObject({ attempted: 4 });
    expect(analytics.series(28, 'UTC', now).failures).toEqual({
      recorded: true,
      days: [{ date: '2026-08-14', attempted: 4, overloaded: 2, serverError: 2 }],
    });
    database.close();
  });

  it('keeps one refusal per request when a safeguard block joins a classifier signal', async () => {
    const safeguard = (uuid: string, requestId: string | null, timestamp: string) => ({
      type: 'assistant',
      uuid,
      requestId,
      sessionId: 's1',
      timestamp,
      error: 'invalid_request',
      isApiErrorMessage: true,
      message: {
        model: '<synthetic>',
        usage: { output_tokens: 0 },
        content: [{ type: 'text', text: 'PRIVATE_API_ERROR_TEXT' }],
      },
    });
    const { database, analytics } = await fixture([
      safeguard('s1', 'shared', '2020-08-14T12:00:00.000Z'),
      {
        type: 'system',
        subtype: 'model_refusal_no_fallback',
        uuid: 'c1',
        requestId: 'shared',
        sessionId: 's1',
        timestamp: '2020-08-14T12:00:01.000Z',
        apiRefusalCategory: 'PRIVATE_CATEGORY',
      },
      safeguard('s2', 'solo', '2020-08-14T12:10:00.000Z'),
      // Rows without a request id can never be merged with one another.
      safeguard('s3', null, '2020-08-14T12:20:00.000Z'),
      {
        type: 'system',
        uuid: 'c2',
        sessionId: 's1',
        timestamp: '2020-08-14T12:30:00.000Z',
        apiRefusalCategory: 'PRIVATE_CATEGORY',
      },
    ]);

    expect(analytics.refusals('UTC')).toMatchObject({
      attempted: 4,
      recovered: 0,
      userVisible: 3,
      unknown: 1,
    });
    const shared = database
      .getRefusals()
      .filter((refusal) => refusal.requestId === database.digest('request:shared'));
    expect(shared).toMatchObject([{ eventId: database.digest('event:c1') }]);
    // Archived rows dedupe the same way once the live events are gone.
    database.db.prepare('DELETE FROM events').run();
    expect(database.getRefusals().map(({ eventId }) => eventId)).toEqual([
      database.digest('event:c1'),
      database.digest('event:s2'),
      database.digest('event:s3'),
      database.digest('event:c2'),
    ]);
    expect(analytics.failures('UTC').attempted).toBe(0);
    database.close();
  });

  it('keeps distinct refusals that merely share a request id', async () => {
    const safeguard = (uuid: string, requestId: string, timestamp: string) => ({
      type: 'assistant',
      uuid,
      requestId,
      sessionId: 's1',
      timestamp,
      error: 'invalid_request',
      isApiErrorMessage: true,
      message: {
        model: '<synthetic>',
        usage: { output_tokens: 0 },
        content: [{ type: 'text', text: 'PRIVATE_API_ERROR_TEXT' }],
      },
    });
    const classifier = (uuid: string, requestId: string, timestamp: string, subtype: string) => ({
      type: 'system',
      subtype,
      uuid,
      requestId,
      sessionId: 's1',
      timestamp,
      apiRefusalCategory: 'PRIVATE_CATEGORY',
    });
    const { database, analytics } = await fixture([
      // Two classifier signals on one request are two refusals, not one.
      classifier('c1', 'both-classifier', '2020-08-14T12:00:00.000Z', 'model_refusal_fallback'),
      classifier('c2', 'both-classifier', '2020-08-14T12:00:05.000Z', 'model_refusal_no_fallback'),
      // Two safeguard blocks on one request are likewise two refusals.
      safeguard('s1', 'both-safeguard', '2020-08-14T12:10:00.000Z'),
      safeguard('s2', 'both-safeguard', '2020-08-14T12:10:05.000Z'),
    ]);

    const eventIds = () => database.getRefusals().map(({ eventId }) => eventId);
    expect(eventIds()).toEqual([
      database.digest('event:c1'),
      database.digest('event:c2'),
      database.digest('event:s1'),
      database.digest('event:s2'),
    ]);
    expect(analytics.refusals('UTC')).toMatchObject({
      attempted: 4,
      recovered: 1,
      userVisible: 3,
      unknown: 0,
    });
    // The archived union must not collapse them either.
    database.db.prepare('DELETE FROM events').run();
    expect(eventIds()).toEqual([
      database.digest('event:c1'),
      database.digest('event:c2'),
      database.digest('event:s1'),
      database.digest('event:s2'),
    ]);
    database.close();
  });

  it('reports a refusal without a named model as unattributed, not as family other', async () => {
    const safeguard = (uuid: string, requestId: string, timestamp: string) => ({
      type: 'assistant',
      uuid,
      requestId,
      sessionId: 's1',
      timestamp,
      error: 'invalid_request',
      isApiErrorMessage: true,
      message: {
        model: '<synthetic>',
        usage: { output_tokens: 0 },
        content: [{ type: 'text', text: 'PRIVATE_API_ERROR_TEXT' }],
      },
    });
    const { database, analytics } = await fixture([
      { type: 'user', uuid: 'u1', sessionId: 's1', timestamp: '2026-08-14T12:00:00.000Z' },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'r-opus',
        sessionId: 's1',
        timestamp: '2026-08-14T12:00:02.000Z',
        message: { model: 'claude-opus-4-20250514', usage: { output_tokens: 100 } },
      },
      // A request that produced real output *and* an error row keeps its family.
      { type: 'user', uuid: 'u2', sessionId: 's1', timestamp: '2026-08-14T13:00:00.000Z' },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        requestId: 'r-fable',
        sessionId: 's1',
        timestamp: '2026-08-14T13:00:02.000Z',
        message: { model: 'claude-fable-1-20260101', usage: { output_tokens: 40 } },
      },
      safeguard('e-fable', 'r-fable', '2026-08-14T13:00:05.000Z'),
      // A request whose only assistant row is an error names no model at all.
      safeguard('e-solo', 'r-solo', '2026-08-14T14:00:00.000Z'),
    ]);

    // `<synthetic>` is stored as no model, so it cannot masquerade as a family.
    expect(
      database.db
        .prepare("SELECT model FROM events WHERE type = 'assistant' ORDER BY timestamp_ms")
        .all(),
    ).toEqual([{ model: 'opus' }, { model: 'fable' }, { model: null }, { model: null }]);
    expect(
      database.getRequests().map(({ family, qualityReason }) => ({ family, qualityReason })),
    ).toEqual([
      { family: 'opus', qualityReason: null },
      { family: 'fable', qualityReason: 'api_error' },
      { family: 'other', qualityReason: 'api_error' },
    ]);

    const timeline = analytics.series(28, 'UTC', new Date('2026-08-14T20:00:00Z')).refusals;
    expect(timeline.days).toEqual([
      {
        date: '2026-08-14',
        families: [{ family: 'fable', attempted: 1, recovered: 0, userVisible: 1, unknown: 0 }],
        unattributed: { attempted: 1, recovered: 0, userVisible: 1, unknown: 0 },
      },
    ]);
    // `other` is never an available chip, so a refusal filed there would be
    // counted in the sidebar and then drawn nowhere.
    expect(timeline.days[0].families.map(({ family }) => family)).not.toContain('other');
    expect(analytics.refusals('UTC').attempted).toBe(2);

    // Unattributed refusals survive every family filter, including one that
    // excludes the only family the day actually recorded.
    expect(filterRefusalTimeline(timeline, ['opus'])).toEqual([
      {
        date: '2026-08-14',
        selected: { attempted: 0, recovered: 0, userVisible: 0, unknown: 0 },
        unattributed: { attempted: 1, recovered: 0, userVisible: 1, unknown: 0 },
      },
    ]);
    expect(filterRefusalTimeline(timeline, ['fable'])).toEqual([
      {
        date: '2026-08-14',
        selected: { attempted: 1, recovered: 0, userVisible: 1, unknown: 0 },
        unattributed: { attempted: 1, recovered: 0, userVisible: 1, unknown: 0 },
      },
    ]);
    database.close();
  });
});
