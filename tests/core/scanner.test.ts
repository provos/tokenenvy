import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Analytics } from '../../src/lib/core/analytics';
import { Database } from '../../src/lib/server/database';
import { Scanner } from '../../src/lib/server/scanner';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(chunkSize = 32) {
  const directory = await mkdtemp(join(tmpdir(), 'speedometer-core-'));
  temporaryDirectories.push(directory);
  const database = new Database({ path: ':memory:', hmacKey: 'test-key' });
  const scanner = new Scanner({ root: directory, database, chunkSize, idleMs: 10 });
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
    const scanner = new Scanner({ root: logs, database });
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
      root: directory,
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

    const scanner = new CountingScanner({ root: directory, database, reconciliationMs: 5 });
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
      root: directory,
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

    const scanner = new RetryScanner({ root: directory, database, reconciliationMs: 10 });
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

    const scanner = new PausedScanner({ root: directory, database, reconciliationMs: 5, watchDebounceMs: 5 });
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
});
