import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { Analytics } from '../../src/lib/core/analytics';
import { Database } from '../../src/lib/server/database';
import { Scanner, normalizeRoots } from '../../src/lib/server/scanner';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(chunkSize = 32) {
  const directory = await mkdtemp(join(tmpdir(), 'speedometer-core-'));
  temporaryDirectories.push(directory);
  const database = new Database({ path: ':memory:', hmacKey: 'test-key' });
  const scanner = new Scanner({ roots: [directory], database, chunkSize, idleMs: 10 });
  const analytics = new Analytics(database);
  return { directory, database, scanner, analytics };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function user(uuid: string, timestamp: string, sessionId = 'session-a') {
  return { type: 'user', uuid, parentUuid: null, sessionId, timestamp, message: { content: 'PRIVATE_PROMPT' } };
}

function assistant(options: {
  uuid: string;
  parentUuid: string;
  requestId?: string;
  timestamp: string;
  output: number;
  model?: string;
  sessionId?: string;
}) {
  return {
    type: 'assistant',
    uuid: options.uuid,
    parentUuid: options.parentUuid,
    requestId: options.requestId ?? 'request-a',
    sessionId: options.sessionId ?? 'session-a',
    timestamp: options.timestamp,
    message: {
      model: options.model ?? 'claude-sonnet-4-20250514',
      content: [{ type: 'text', text: 'PRIVATE_RESPONSE' }],
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
        output_tokens: options.output
      }
    }
  };
}

describe('incremental scanner', () => {
  it('normalizes duplicate and overlapping monitored roots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speedometer-roots-'));
    temporaryDirectories.push(directory);
    const nested = join(directory, 'nested');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(nested));
    expect(normalizeRoots([nested, directory, directory, nested])).toEqual([directory]);
  });

  it('scans multiple roots while deduplicating copied events', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'speedometer-root-a-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'speedometer-root-b-'));
    temporaryDirectories.push(firstRoot, secondRoot);
    const payload =
      line(user('u1', '2020-08-14T12:00:00.000Z')) +
      line(assistant({ uuid: 'a1', parentUuid: 'u1', timestamp: '2020-08-14T12:00:02.000Z', output: 20 }));
    await writeFile(join(firstRoot, 'one.jsonl'), payload);
    await writeFile(join(secondRoot, 'copy.jsonl'), payload);
    const database = new Database({ path: ':memory:', hmacKey: 'multi-root-key' });
    const scanner = new Scanner({ roots: [firstRoot, secondRoot], database });

    await scanner.scanAll();
    expect(scanner.getStatus().filesDiscovered).toBe(2);
    expect(database.getDataQuality()).toMatchObject({
      files: 2, uniqueEvents: 2, duplicateOccurrences: 2, requests: 1, archivedRequests: 1
    });
    database.close();
  });

  it('does not retract a healthy or unavailable root while reconciling the other', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'speedometer-isolation-a-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'speedometer-isolation-b-'));
    temporaryDirectories.push(firstRoot, secondRoot);
    await writeFile(
      join(firstRoot, 'one.jsonl'),
      line(user('u1', '2026-08-14T12:00:00.000Z', 's1')) +
        line(assistant({ uuid: 'a1', parentUuid: 'u1', requestId: 'r1', sessionId: 's1', timestamp: '2026-08-14T12:00:02.000Z', output: 20 }))
    );
    await writeFile(
      join(secondRoot, 'two.jsonl'),
      line(user('u2', '2026-08-14T13:00:00.000Z', 's2')) +
        line(assistant({ uuid: 'a2', parentUuid: 'u2', requestId: 'r2', sessionId: 's2', timestamp: '2026-08-14T13:00:02.000Z', output: 30 }))
    );
    const database = new Database({ path: ':memory:', hmacKey: 'isolation-key' });
    const scanner = new Scanner({ roots: [firstRoot, secondRoot], database });
    await scanner.scanAll();
    expect(database.getRequests()).toHaveLength(2);

    await rm(secondRoot, { recursive: true, force: true });
    await appendFile(
      join(firstRoot, 'one.jsonl'),
      line(assistant({ uuid: 'a3', parentUuid: 'a1', requestId: 'r1', sessionId: 's1', timestamp: '2026-08-14T12:00:04.000Z', output: 40 }))
    );
    await scanner.scanAll();
    expect(scanner.getStatus()).toMatchObject({ state: 'error', filesDiscovered: 1 });
    expect(database.getRequests()).toHaveLength(2);
    expect(database.getDataQuality().files).toBe(2);
    database.close();
  });

  it('scopes file deletion to its owning monitored root', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'speedometer-delete-a-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'speedometer-delete-b-'));
    temporaryDirectories.push(firstRoot, secondRoot);
    const now = new Date();
    const firstFile = join(firstRoot, 'one.jsonl');
    await writeFile(
      firstFile,
      line(user('u1', new Date(now.getTime() - 3_000).toISOString(), 's1')) +
        line(assistant({ uuid: 'a1', parentUuid: 'u1', requestId: 'r1', sessionId: 's1', timestamp: new Date(now.getTime() - 1_000).toISOString(), output: 20 }))
    );
    await writeFile(
      join(secondRoot, 'two.jsonl'),
      line(user('u2', new Date(now.getTime() - 3_000).toISOString(), 's2')) +
        line(assistant({ uuid: 'a2', parentUuid: 'u2', requestId: 'r2', sessionId: 's2', timestamp: new Date(now.getTime() - 1_000).toISOString(), output: 30 }))
    );
    const database = new Database({ path: ':memory:', hmacKey: 'delete-isolation-key' });
    const scanner = new Scanner({ roots: [firstRoot, secondRoot], database });
    await scanner.scanAll();
    await rm(firstFile);
    await scanner.scanAll();

    expect(database.getRequests()).toMatchObject([{ outputTokens: 30 }]);
    expect(database.getDataQuality()).toMatchObject({ files: 1, archivedRequests: 0 });
    database.close();
  });

  it('treats a never-seen missing root as empty while continuing to reconcile it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speedometer-missing-parent-'));
    temporaryDirectories.push(directory);
    const missing = join(directory, 'not-created-yet');
    const database = new Database({ path: ':memory:', hmacKey: 'missing-root-key' });
    const scanner = new Scanner({ roots: [missing], database, reconciliationMs: 0 });

    await expect(scanner.scanAll()).resolves.toMatchObject({
      state: 'idle', filesDiscovered: 0, lastError: null
    });
    await import('node:fs/promises').then(({ mkdir }) => mkdir(missing));
    await writeFile(
      join(missing, 'later.jsonl'),
      line(user('u1', '2020-08-14T12:00:00.000Z')) +
        line(assistant({ uuid: 'a1', parentUuid: 'u1', timestamp: '2020-08-14T12:00:02.000Z', output: 20 }))
    );
    await scanner.scanAll();
    expect(database.getRequests()).toHaveLength(1);
    database.close();
  });

  it('tails only complete lines and reopens a request when late parts arrive', async () => {
    const { directory, database, scanner } = await setup(7);
    const file = join(directory, 'session.jsonl');
    const first = line(user('u1', '2026-08-14T12:00:00.000Z'));
    const assistantLine = line(
      assistant({ uuid: 'a1', parentUuid: 'u1', timestamp: '2026-08-14T12:00:02.000Z', output: 10 })
    );
    await writeFile(file, first + assistantLine.slice(0, -8));
    await scanner.scanAll();
    expect(database.getRequests()).toHaveLength(0);

    await appendFile(file, assistantLine.slice(-8));
    await scanner.scanFile(file);
    expect(database.getRequests()).toMatchObject([
      { durationMs: 2_000, outputTokens: 10, family: 'sonnet', tokensPerSecond: 5 }
    ]);

    await appendFile(
      file,
      line(assistant({ uuid: 'a2', parentUuid: 'a1', timestamp: '2026-08-14T12:00:04.000Z', output: 20 }))
    );
    await scanner.scanFile(file);
    expect(database.getRequests()[0]).toMatchObject({ durationMs: 4_000, outputTokens: 20, tokensPerSecond: 5 });
    database.close();
  });

  it('reads very large rows without losing complete-line byte offsets', async () => {
    const { directory, database, scanner } = await setup(257);
    const file = join(directory, 'large-row.jsonl');
    const first = line({
      ...user('u1', '2026-08-14T12:00:00.000Z'),
      message: { content: 'PRIVATE_LARGE_PROMPT'.repeat(60_000) }
    });
    const second = line(
      assistant({ uuid: 'a1', parentUuid: 'u1', timestamp: '2026-08-14T12:00:02.000Z', output: 20 })
    );
    const partial = JSON.stringify(user('u2', '2026-08-14T13:00:00.000Z'));
    await writeFile(file, first + second + partial);

    await scanner.scanAll();
    expect(database.getRequests()).toHaveLength(1);
    expect(
      database.db.prepare('SELECT line_offset FROM occurrences ORDER BY line_offset').all()
    ).toEqual([{ line_offset: 0 }, { line_offset: Buffer.byteLength(first) }]);
    const sourceId = database.sourceId(file);
    expect(database.getFileCheckpoint(sourceId)).toMatchObject({
      offset: Buffer.byteLength(first) + Buffer.byteLength(second),
      rowsRead: 2
    });

    await appendFile(file, '\n');
    await scanner.scanFile(file);
    expect(
      database.db.prepare('SELECT line_offset FROM occurrences ORDER BY line_offset').all()
    ).toEqual([
      { line_offset: 0 },
      { line_offset: Buffer.byteLength(first) },
      { line_offset: Buffer.byteLength(first) + Buffer.byteLength(second) }
    ]);
    database.close();
  });

  it('deduplicates copied history and retracts only after the last occurrence disappears', async () => {
    const { directory, database, scanner } = await setup();
    const payload =
      line(user('u1', '2026-08-14T12:00:00.000Z')) +
      line(assistant({ uuid: 'a1', parentUuid: 'u1', timestamp: '2026-08-14T12:00:02.000Z', output: 20 }));
    const original = join(directory, 'one.jsonl');
    const copy = join(directory, 'two.jsonl');
    await writeFile(original, payload);
    await writeFile(copy, payload);
    await scanner.scanAll();
    expect(database.getDataQuality()).toMatchObject({ uniqueEvents: 2, duplicateOccurrences: 2, requests: 1 });

    await scanner.removeFile(original);
    expect(database.getRequests()).toHaveLength(1);
    await scanner.removeFile(copy);
    expect(database.getRequests()).toHaveLength(0);
    database.close();
  });

  it('retracts stale rows after truncation/replacement and records malformed complete rows', async () => {
    const { directory, database, scanner } = await setup();
    const file = join(directory, 'replace.jsonl');
    await writeFile(
      file,
      line(user('u1', '2026-08-14T12:00:00.000Z')) +
        line(assistant({ uuid: 'a1', parentUuid: 'u1', timestamp: '2026-08-14T12:00:02.000Z', output: 20 }))
    );
    await scanner.scanAll();
    expect(database.getRequests()).toHaveLength(1);

    await truncate(file, 0);
    await writeFile(file, `${line(user('u2', '2026-08-14T13:00:00.000Z'))}{not-json}\n`);
    await scanner.scanFile(file);
    expect(database.getRequests()).toHaveLength(0);
    expect(database.getDataQuality()).toMatchObject({ uniqueEvents: 1, invalidRows: 1 });
    database.close();
  });

  it('does not persist transcript content or raw identifiers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speedometer-privacy-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'speedometer.sqlite');
    const logs = join(directory, 'logs');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(logs));
    const file = join(logs, 'private.jsonl');
    await writeFile(
      file,
      line(user('RAW-USER-UUID', '2026-08-14T12:00:00.000Z')) +
        line(
          assistant({
            uuid: 'RAW-ASSISTANT-UUID',
            parentUuid: 'RAW-USER-UUID',
            requestId: 'RAW-REQUEST-ID',
            timestamp: '2026-08-14T12:00:02.000Z',
            output: 20
          })
        ) +
        line({
          type: 'system',
          subtype: 'model_refusal_no_fallback',
          uuid: 'RAW-REFUSAL-UUID',
          sessionId: 'session-a',
          timestamp: '2026-08-14T12:00:03.000Z',
          apiRefusalCategory: 'PRIVATE_REFUSAL_CATEGORY',
          apiRefusalExplanation: 'PRIVATE_REFUSAL_EXPLANATION'
        })
    );
    const database = new Database({ path: dbPath, hmacKey: 'test-key' });
    const scanner = new Scanner({ roots: [logs], database });
    await scanner.scanAll();
    database.close();
    const bytes = (await readFile(dbPath)).toString('utf8');
    expect(bytes).not.toContain('PRIVATE_PROMPT');
    expect(bytes).not.toContain('PRIVATE_RESPONSE');
    expect(bytes).not.toContain('RAW-REQUEST-ID');
    expect(bytes).not.toContain('RAW-USER-UUID');
    expect(bytes).not.toContain('PRIVATE_REFUSAL_CATEGORY');
    expect(bytes).not.toContain('PRIVATE_REFUSAL_EXPLANATION');
  });

  it('does not run orphan collection for newly discovered files', async () => {
    const { directory, database, scanner } = await setup();
    await writeFile(
      join(directory, 'new.jsonl'),
      line(user('u1', '2026-08-14T12:00:00.000Z')) +
        line(assistant({ uuid: 'a1', parentUuid: 'u1', timestamp: '2026-08-14T12:00:02.000Z', output: 20 }))
    );
    const orphanSweep = vi.spyOn(database as any, 'deleteOrphanEvents');
    await scanner.scanAll();
    expect(orphanSweep).not.toHaveBeenCalled();
    expect(database.getRequests()).toHaveLength(1);
    database.close();
  });

  it('watches before the initial reconciliation so startup events are not lost', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speedometer-race-'));
    temporaryDirectories.push(directory);
    const database = new Database({ path: ':memory:', hmacKey: 'race-key' });
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolveStarted) => (markStarted = resolveStarted));
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));

    class PausedInitialScanner extends Scanner {
      override async scanAll() {
        markStarted();
        await gate;
        return this.getStatus();
      }
    }

    const scanner = new PausedInitialScanner({
      roots: [directory],
      database,
      idleMs: 10,
      reconciliationMs: 0
    });
    const start = scanner.start();
    await started;
    await writeFile(
      join(directory, 'during-start.jsonl'),
      line(user('u1', '2026-08-14T12:00:00.000Z')) +
        line(assistant({ uuid: 'a1', parentUuid: 'u1', timestamp: '2026-08-14T12:00:02.000Z', output: 20 }))
    );
    release();
    await start;
    await vi.waitFor(() => expect(database.getRequests()).toHaveLength(1), { timeout: 2_000, interval: 10 });
    await scanner.stop();
    database.close();
  });

  it('serializes periodic reconciliations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speedometer-periodic-'));
    temporaryDirectories.push(directory);
    const database = new Database({ path: ':memory:', hmacKey: 'periodic-key' });

    class CountingScanner extends Scanner {
      calls = 0;
      active = 0;
      maxActive = 0;

      override async scanAll() {
        this.calls += 1;
        this.active += 1;
        this.maxActive = Math.max(this.maxActive, this.active);
        await new Promise((resolveWait) => setTimeout(resolveWait, 12));
        this.active -= 1;
        return this.getStatus();
      }
    }

    const scanner = new CountingScanner({ roots: [directory], database, reconciliationMs: 5 });
    await scanner.start();
    await new Promise((resolveWait) => setTimeout(resolveWait, 35));
    await scanner.stop();
    expect(scanner.calls).toBeGreaterThan(1);
    expect(scanner.maxActive).toBe(1);
    database.close();
  });

  it('coalesces a burst of watched appends into one request rebuild', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speedometer-coalesce-'));
    temporaryDirectories.push(directory);
    const database = new Database({ path: ':memory:', hmacKey: 'coalesce-key' });
    const scanner = new Scanner({
      roots: [directory],
      database,
      idleMs: 10_000,
      reconciliationMs: 0,
      watchDebounceMs: 75
    });
    const rebuild = vi.spyOn(database, 'rebuildRequests');
    const file = join(directory, 'burst.jsonl');
    await writeFile(file, line(user('u1', '2026-08-14T12:00:00.000Z')));
    for (let index = 0; index < 8; index += 1) {
      await appendFile(
        file,
        line(
          assistant({
            uuid: `a${index}`,
            parentUuid: index === 0 ? 'u1' : `a${index - 1}`,
            timestamp: `2026-08-14T12:00:${String(index + 1).padStart(2, '0')}.000Z`,
            output: (index + 1) * 10
          })
        )
      );
    }
    const notify = scanner as unknown as {
      queueWatchAction(filePath: string, action: 'scan' | 'remove'): void;
    };
    for (let index = 0; index < 100; index += 1) notify.queueWatchAction(file, 'scan');

    await vi.waitFor(() => expect(database.getRequests()).toHaveLength(1), { timeout: 2_000, interval: 10 });
    expect(rebuild).toHaveBeenCalledTimes(1);
    await scanner.stop();
    database.close();
  });

  it('keeps reconciliation armed after a transient initial scan failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speedometer-retry-'));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, 'retry.jsonl'),
      line(user('u1', '2026-08-14T12:00:00.000Z')) +
        line(assistant({ uuid: 'a1', parentUuid: 'u1', timestamp: '2026-08-14T12:00:02.000Z', output: 20 }))
    );
    const database = new Database({ path: ':memory:', hmacKey: 'retry-key' });

    class RetryScanner extends Scanner {
      calls = 0;

      override async scanAll(rebuildWhenUnchanged = true) {
        this.calls += 1;
        if (this.calls === 1) throw new Error('transient discovery failure');
        return super.scanAll(rebuildWhenUnchanged);
      }
    }

    const scanner = new RetryScanner({ roots: [directory], database, reconciliationMs: 10 });
    await expect(scanner.start()).rejects.toThrow('transient discovery failure');
    await vi.waitFor(() => expect(database.getRequests()).toHaveLength(1), { timeout: 2_000, interval: 10 });
    expect(scanner.calls).toBeGreaterThanOrEqual(2);
    await scanner.stop();
    database.close();
  });

  it('does not enqueue more work after shutdown begins', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speedometer-stop-'));
    temporaryDirectories.push(directory);
    const database = new Database({ path: ':memory:', hmacKey: 'stop-key' });
    let entered!: () => void;
    let release!: () => void;
    const scanning = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));

    class PausedScanner extends Scanner {
      calls = 0;

      override async scanAll() {
        this.calls += 1;
        entered();
        await gate;
        return this.getStatus();
      }
    }

    const scanner = new PausedScanner({ roots: [directory], database, reconciliationMs: 5, watchDebounceMs: 5 });
    const start = scanner.start();
    await scanning;
    const stop = scanner.stop();
    release();
    await Promise.all([start, stop]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    expect(scanner.calls).toBe(1);
    database.close();
  });

  it('batches orphan collection when multiple sources disappear together', async () => {
    const { directory, database, scanner } = await setup();
    const payload =
      line(user('u1', '2026-08-14T12:00:00.000Z')) +
      line(assistant({ uuid: 'a1', parentUuid: 'u1', timestamp: '2026-08-14T12:00:02.000Z', output: 20 }));
    const first = join(directory, 'first.jsonl');
    const second = join(directory, 'second.jsonl');
    await writeFile(first, payload);
    await writeFile(second, payload);
    await scanner.scanAll();
    const orphanSweep = vi.spyOn(database as any, 'deleteOrphanEvents');
    await rm(first);
    await rm(second);

    await scanner.scanAll();
    expect(orphanSweep).toHaveBeenCalledTimes(1);
    expect(database.getRequests()).toHaveLength(0);
    database.close();
  });

  it('preserves stable request history after upstream deletion but drops recent provisional data', async () => {
    const { directory, database, scanner } = await setup();
    const oldFile = join(directory, 'old.jsonl');
    const recentFile = join(directory, 'recent.jsonl');
    await writeFile(
      oldFile,
      line(user('old-u', '2020-08-14T12:00:00.000Z', 'old-session')) +
        line(assistant({ uuid: 'old-a', parentUuid: 'old-u', requestId: 'old-r', sessionId: 'old-session', timestamp: '2020-08-14T12:00:02.000Z', output: 20 }))
    );
    const now = new Date();
    await writeFile(
      recentFile,
      line(user('new-u', new Date(now.getTime() - 2_000).toISOString(), 'new-session')) +
        line(assistant({ uuid: 'new-a', parentUuid: 'new-u', requestId: 'new-r', sessionId: 'new-session', timestamp: now.toISOString(), output: 30 }))
    );
    await scanner.scanAll();
    expect(database.getDataQuality()).toMatchObject({ requests: 2, archivedRequests: 1 });

    await rm(oldFile);
    await rm(recentFile);
    await scanner.scanAll();
    expect(database.getRequests()).toMatchObject([{ outputTokens: 20, provisional: false }]);
    expect(database.getDataQuality()).toMatchObject({ files: 0, requests: 1, archivedRequests: 1 });
    database.close();
  });

  it('clears only live state during a rescan reset', async () => {
    const { directory, database, scanner } = await setup();
    await writeFile(
      join(directory, 'old.jsonl'),
      line(user('old-u', '2020-08-14T12:00:00.000Z')) +
        line(assistant({ uuid: 'old-a', parentUuid: 'old-u', requestId: 'old-r', timestamp: '2020-08-14T12:00:02.000Z', output: 20 }))
    );
    await scanner.scanAll();
    database.recordQuotaSample({
      observedAt: new Date(),
      sevenDay: { usedPercentage: 50, resetsAt: new Date(Date.now() + 60_000) }
    });

    database.resetLive();
    expect(database.getRequests()).toMatchObject([{ outputTokens: 20 }]);
    expect(database.getDataQuality()).toMatchObject({ files: 0, uniqueEvents: 0, archivedRequests: 1 });
    expect(database.getQuota()).toMatchObject({ available: true, sevenDay: { usedPercentage: 50 } });
    database.close();
  });

  it('archives an old request even when a stale provisional flag survived a restart', () => {
    const database = new Database({ path: ':memory:', hmacKey: 'stale-provisional-key' });
    database.db.prepare(`
      INSERT INTO requests(
        request_id, session_id, started_at, finished_at, duration_ms, output_tokens,
        input_tokens, cache_read_tokens, cache_creation_tokens, family, stratum,
        tokens_per_second, provisional, quality_reason
      ) VALUES ('old-request', 'old-session', 1597406400000, 1597406402000, 2000,
        20, 0, 0, 0, 'sonnet', 0, 10, 1, NULL)
    `).run();

    database.resetLive(Date.parse('2026-08-14T12:00:00Z'));
    expect(database.getRequests()).toMatchObject([
      { outputTokens: 20, provisional: false, qualityReason: null }
    ]);
    expect(database.getDataQuality()).toMatchObject({ archivedRequests: 1 });
    database.close();
  });

  it('lets stable live corrections replace archived aggregates without duplicating them', async () => {
    const { directory, database, scanner } = await setup();
    const file = join(directory, 'correction.jsonl');
    const corrected = (output: number) =>
      line(user('u1', '2020-08-14T12:00:00.000Z')) +
      line(assistant({ uuid: `a-${output}`, parentUuid: 'u1', requestId: 'request-a', timestamp: '2020-08-14T12:00:02.000Z', output }));
    await writeFile(file, corrected(20));
    await scanner.scanAll();
    expect(database.getRequests()[0].outputTokens).toBe(20);

    await truncate(file, 0);
    await writeFile(file, corrected(45));
    await scanner.scanFile(file);
    expect(database.getRequests()).toMatchObject([{ outputTokens: 45 }]);
    expect(database.db.prepare('SELECT output_tokens FROM request_history').all()).toEqual([{ output_tokens: 45 }]);
    database.close();
  });

  it('keeps a recent correction live-only until it crosses the history cutoff', async () => {
    const { directory, database, scanner } = await setup();
    const file = join(directory, 'late-correction.jsonl');
    await writeFile(
      file,
      line(user('u1', '2020-08-14T12:00:00.000Z')) +
        line(assistant({ uuid: 'old-a', parentUuid: 'u1', requestId: 'request-a', timestamp: '2020-08-14T12:00:02.000Z', output: 20 }))
    );
    await scanner.scanAll();
    const now = new Date();
    await truncate(file, 0);
    await writeFile(
      file,
      line(user('u2', new Date(now.getTime() - 2_000).toISOString())) +
        line(assistant({ uuid: 'new-a', parentUuid: 'u2', requestId: 'request-a', timestamp: now.toISOString(), output: 45 }))
    );
    await scanner.scanFile(file);
    expect(database.getRequests()).toMatchObject([{ outputTokens: 45, provisional: true }]);
    expect(database.db.prepare('SELECT output_tokens FROM request_history').all()).toEqual([{ output_tokens: 20 }]);

    database.rebuildRequests(now.getTime() + 25 * 60 * 60_000, 10);
    expect(database.db.prepare('SELECT output_tokens FROM request_history').all()).toEqual([{ output_tokens: 45 }]);
    await rm(file);
    await scanner.scanAll();
    expect(database.getRequests()).toMatchObject([{ outputTokens: 45, provisional: false }]);
    database.close();
  });

  it('archives stable requests before a source is truncated away', async () => {
    const { directory, database, scanner } = await setup();
    const file = join(directory, 'compacted.jsonl');
    await writeFile(
      file,
      line(user('old-u', '2020-08-14T12:00:00.000Z')) +
        line(assistant({ uuid: 'old-a', parentUuid: 'old-u', requestId: 'old-r', timestamp: '2020-08-14T12:00:02.000Z', output: 20 }))
    );
    await scanner.scanAll();
    await truncate(file, 0);
    await writeFile(file, line(user('unrelated', new Date().toISOString())));

    await scanner.scanFile(file);
    expect(database.getRequests()).toMatchObject([{ outputTokens: 20 }]);
    expect(database.getDataQuality()).toMatchObject({ archivedRequests: 1 });
    database.close();
  });

  it('preserves stable refusal outcomes across deletion and restart without private fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speedometer-refusal-history-'));
    temporaryDirectories.push(directory);
    const logs = join(directory, 'logs');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(logs));
    const file = join(logs, 'refusal.jsonl');
    await writeFile(file, line({
      type: 'system', subtype: 'model_refusal_no_fallback', uuid: 'raw-refusal-id',
      requestId: 'raw-request-id', sessionId: 'raw-session-id', timestamp: '2020-08-14T12:00:03.000Z',
      apiRefusalCategory: 'PRIVATE_CATEGORY', apiRefusalExplanation: 'PRIVATE_EXPLANATION'
    }));
    const dbPath = join(directory, 'history.sqlite3');
    let database = new Database({ path: dbPath, hmacKey: 'restart-key' });
    const scanner = new Scanner({ roots: [logs], database });
    await scanner.scanAll();
    await rm(file);
    await scanner.scanAll();
    expect(database.getRefusals()).toMatchObject([{ outcome: 'user_visible' }]);
    database.close();

    database = new Database({ path: dbPath, hmacKey: 'restart-key' });
    expect(database.getRefusals()).toMatchObject([{ outcome: 'user_visible' }]);
    expect(database.getDataQuality()).toMatchObject({ archivedRefusals: 1 });
    database.close();
    const bytes = (await readFile(dbPath)).toString('utf8');
    expect(bytes).not.toContain('PRIVATE_CATEGORY');
    expect(bytes).not.toContain('PRIVATE_EXPLANATION');
    expect(bytes).not.toContain(logs);
    expect(bytes).not.toContain('raw-refusal-id');
  });

  it('updates archived refusal outcomes when a stable source is corrected', async () => {
    const { directory, database, scanner } = await setup();
    const file = join(directory, 'refusal-correction.jsonl');
    const refusal = (subtype: string) => line({
      type: 'system', subtype, uuid: 'refusal-id', requestId: 'request-id',
      sessionId: 'session-id', timestamp: '2020-08-14T12:00:03.000Z'
    });
    await writeFile(file, refusal('model_refusal_no_fallback'));
    await scanner.scanAll();
    expect(database.getRefusals()).toMatchObject([{ outcome: 'user_visible' }]);

    await truncate(file, 0);
    await writeFile(file, refusal('model_refusal_fallback'));
    await scanner.scanFile(file);
    expect(database.getRefusals()).toMatchObject([{ outcome: 'recovered' }]);
    expect(database.db.prepare('SELECT refusal_outcome FROM refusal_history').all()).toEqual([
      { refusal_outcome: 'recovered' }
    ]);
    database.close();
  });

  it('removes an archived refusal after a stable correction to a non-refusal', async () => {
    const { directory, database, scanner } = await setup();
    const file = join(directory, 'refusal-removal.jsonl');
    await writeFile(file, line({
      type: 'system', subtype: 'model_refusal_no_fallback', uuid: 'refusal-id',
      requestId: 'request-id', sessionId: 'session-id', timestamp: '2020-08-14T12:00:03.000Z'
    }));
    await scanner.scanAll();
    expect(database.getRefusals()).toMatchObject([{ outcome: 'user_visible' }]);

    await truncate(file, 0);
    await writeFile(file, line({
      type: 'system', subtype: 'turn_duration', uuid: 'refusal-id',
      requestId: 'request-id', sessionId: 'session-id', timestamp: '2020-08-14T12:00:03.000Z'
    }));
    await scanner.scanFile(file);
    expect(database.getRefusals()).toEqual([]);
    expect(database.db.prepare('SELECT * FROM refusal_history').all()).toEqual([]);

    await rm(file);
    await scanner.scanAll();
    expect(database.getRefusals()).toEqual([]);
    database.close();
  });

  it('preserves live data when a watched root becomes unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speedometer-root-unlink-'));
    temporaryDirectories.push(directory);
    const logs = join(directory, 'logs');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(logs));
    const file = join(logs, 'session.jsonl');
    await writeFile(
      file,
      line(user('u1', new Date(Date.now() - 4_000).toISOString())) +
        line(assistant({
          uuid: 'a1', parentUuid: 'u1', requestId: 'r1',
          timestamp: new Date(Date.now() - 2_000).toISOString(), output: 20
        }))
    );
    const database = new Database({ path: ':memory:', hmacKey: 'root-unlink-key' });
    const scanner = new Scanner({ roots: [logs], database, idleMs: 10, reconciliationMs: 0, watchDebounceMs: 10 });
    await scanner.start();
    expect(database.getRequests()).toHaveLength(1);

    await rm(logs, { recursive: true });
    await vi.waitFor(() => expect(scanner.getStatus().state).toBe('error'), { timeout: 2_000, interval: 10 });
    expect(database.getRequests()).toHaveLength(1);
    expect(database.getDataQuality()).toMatchObject({ files: 1 });
    await scanner.stop();
    database.close();
  });

  it('does not retract unassigned v1 sources when multiple configured roots are unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speedometer-legacy-roots-'));
    temporaryDirectories.push(directory);
    const database = new Database({ path: ':memory:', hmacKey: 'legacy-roots-key' });
    database.db.prepare(`
      INSERT INTO files(source_id, root_id, identity, size, offset, mtime_ms, tail_hash, rows_read, invalid_rows)
      VALUES ('legacy-source', '', '1:1', 1, 1, 1, '', 1, 0)
    `).run();
    database.db.prepare(`
      INSERT INTO events(
        event_id, parent_id, request_id, session_id, timestamp_ms, type, model, output_tokens
      ) VALUES ('legacy-user', NULL, NULL, 'legacy-session', 1597406400000, 'user', NULL, 0)
    `).run();
    database.db.prepare(`
      INSERT INTO events(
        event_id, parent_id, request_id, session_id, timestamp_ms, type, model, output_tokens
      ) VALUES ('legacy-assistant', 'legacy-user', 'legacy-request', 'legacy-session', 1597406402000,
        'assistant', 'sonnet', 20)
    `).run();
    database.db.prepare(
      'INSERT INTO occurrences(source_id, line_offset, event_id) VALUES (?, ?, ?)'
    ).run('legacy-source', 0, 'legacy-user');
    database.db.prepare(
      'INSERT INTO occurrences(source_id, line_offset, event_id) VALUES (?, ?, ?)'
    ).run('legacy-source', 1, 'legacy-assistant');
    database.rebuildRequests(Date.parse('2020-08-14T12:00:03Z'), 120_000);

    const scanner = new Scanner({
      roots: [join(directory, 'missing-a'), join(directory, 'missing-b')],
      database,
      reconciliationMs: 0
    });
    await scanner.scanAll();
    expect(scanner.getStatus().state).toBe('error');
    expect(database.getRequests()).toHaveLength(1);
    expect(database.getDataQuality()).toMatchObject({ files: 1 });
    database.close();
  });

  it('migrates a v1 live index into root-aware durable history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speedometer-v1-migration-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'v1.sqlite3');
    const legacy = new BetterSqlite3(dbPath);
    legacy.exec(`
      CREATE TABLE files (
        source_id TEXT PRIMARY KEY, identity TEXT NOT NULL, size INTEGER NOT NULL,
        offset INTEGER NOT NULL, mtime_ms REAL NOT NULL, tail_hash TEXT NOT NULL,
        rows_read INTEGER NOT NULL DEFAULT 0, invalid_rows INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY, parent_id TEXT, request_id TEXT, session_id TEXT NOT NULL,
        timestamp_ms INTEGER, type TEXT NOT NULL, subtype TEXT, model TEXT,
        output_tokens INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        synthetic INTEGER NOT NULL DEFAULT 0, refusal_outcome TEXT, quality_flags TEXT
      );
      CREATE TABLE occurrences (
        source_id TEXT NOT NULL REFERENCES files(source_id) ON DELETE CASCADE,
        line_offset INTEGER NOT NULL, event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
        PRIMARY KEY(source_id, line_offset)
      );
      CREATE TABLE requests (
        request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, started_at INTEGER,
        finished_at INTEGER, duration_ms INTEGER, output_tokens INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
        cache_creation_tokens INTEGER NOT NULL, family TEXT NOT NULL, stratum INTEGER NOT NULL,
        tokens_per_second REAL, provisional INTEGER NOT NULL, quality_reason TEXT
      );
    `);
    legacy.prepare(`
      INSERT INTO requests VALUES (
        'legacy-request', 'legacy-session', 1597406400000, 1597406402000, 2000,
        20, 100, 50, 10, 'sonnet', 0, 10, 0, NULL
      )
    `).run();
    legacy.prepare(`
      INSERT INTO events(
        event_id, request_id, session_id, timestamp_ms, type, refusal_outcome
      ) VALUES ('legacy-refusal', 'legacy-request', 'legacy-session', 1597406403000, 'system', 'recovered')
    `).run();
    legacy.close();

    const database = new Database({ path: dbPath, hmacKey: 'migration-key' });
    expect(database.db.pragma('user_version', { simple: true })).toBe(2);
    expect(database.db.pragma('table_info(files)')).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'root_id' })])
    );
    expect(database.getRequests()).toMatchObject([{ outputTokens: 20, family: 'sonnet' }]);
    expect(database.getRefusals()).toMatchObject([{ outcome: 'recovered' }]);
    expect(database.getDataQuality()).toMatchObject({ archivedRequests: 1, archivedRefusals: 1 });
    database.close();
  });
});
