import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { normalizeModelFamily, outputSizeStratum } from '../core/model';
import type { ParsedEvent } from '../core/parser';
import type { ModelFamily, QuotaModelWindows, QuotaResponse, ScanStatus } from '../types';
import { PLATFORM_FAILURE_CLASSES } from '../types';

export interface DatabaseOptions {
  path: string;
  hmacKey?: Buffer | string;
}

export interface FileCheckpoint {
  sourceId: string;
  rootId: string;
  identity: string;
  size: number;
  offset: number;
  mtimeMs: number;
  tailHash: string;
  rowsRead: number;
  invalidRows: number;
}

export interface ScannedEvent {
  lineOffset: number;
  event: ParsedEvent;
}

export interface StoredRequest {
  requestId: string;
  sessionId: string;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  family: ModelFamily;
  /**
   * Whether any assistant row in the request actually named a model. A request
   * whose only rows are API-error rows names none, and `family` then holds the
   * `other` placeholder that keeps the column non-null and the API contract
   * fixed. Consumers that must not invent an attribution read this first.
   */
  familyKnown: boolean;
  stratum: number;
  tokensPerSecond: number | null;
  provisional: boolean;
  qualityReason: string | null;
}

export interface StoredRefusal {
  eventId: string;
  requestId: string | null;
  sessionId: string;
  timestampMs: number;
  outcome: 'recovered' | 'user_visible' | 'unknown';
}

/**
 * Only platform faults are surfaced. `safeguard_block` is reported through
 * refusals and `client` covers local faults that say nothing about the service.
 */
export interface StoredFailure {
  eventId: string;
  requestId: string | null;
  sessionId: string;
  timestampMs: number;
  failureClass: (typeof PLATFORM_FAILURE_CLASSES)[number];
}

export interface QuotaSampleInput {
  fiveHour?: { usedPercentage: number; resetsAt: string | number | Date } | null;
  sevenDay?: { usedPercentage: number; resetsAt: string | number | Date } | null;
  model?: string | null;
  observedAt?: string | number | Date;
}

export interface DataQualitySummary {
  files: number;
  rows: number;
  invalidRows: number;
  uniqueEvents: number;
  duplicateOccurrences: number;
  uuidMissing: number;
  requests: number;
  includedRequests: number;
  archivedRequests: number;
  archivedRefusals: number;
  exclusions: Record<string, number>;
}

export interface StoredSource {
  sourceId: string;
  rootId: string;
}

export const HISTORY_STABILITY_MS = 24 * 60 * 60_000;

const EMPTY_SCAN_STATUS: ScanStatus = {
  state: 'idle',
  filesDiscovered: 0,
  filesScanned: 0,
  bytesRead: 0,
  rowsRead: 0,
  invalidRows: 0,
  updatedAt: null,
  lastError: null,
  revision: 0,
};

function keyFor(options: DatabaseOptions): Buffer {
  if (options.hmacKey)
    return Buffer.isBuffer(options.hmacKey) ? options.hmacKey : Buffer.from(options.hmacKey);
  if (options.path === ':memory:') return randomBytes(32);

  const keyPath = `${options.path}.key`;
  if (existsSync(keyPath)) return readFileSync(keyPath);
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
  return key;
}

function toMillis(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(value);
}

export class Database {
  readonly db: BetterSqliteDatabase;
  readonly #key: Buffer;
  #requestRevision = 0;
  #dataQuality: { revision: number; summary: DataQualitySummary } | null = null;
  #scanStatus: ScanStatus = { ...EMPTY_SCAN_STATUS };

  constructor(options: DatabaseOptions | string) {
    const normalized = typeof options === 'string' ? { path: options } : options;
    this.#key = keyFor(normalized);
    if (normalized.path !== ':memory:')
      mkdirSync(dirname(normalized.path), { recursive: true, mode: 0o700 });
    this.db = new BetterSqlite3(normalized.path);
    if (normalized.path !== ':memory:') chmodSync(normalized.path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('temp_store = MEMORY');
    this.migrate();
    this.archiveStable(Date.now());
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        source_id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL DEFAULT '',
        identity TEXT NOT NULL,
        size INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        tail_hash TEXT NOT NULL,
        rows_read INTEGER NOT NULL DEFAULT 0,
        invalid_rows INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        parent_id TEXT,
        request_id TEXT,
        session_id TEXT NOT NULL,
        timestamp_ms INTEGER,
        type TEXT NOT NULL,
        subtype TEXT,
        model TEXT,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        synthetic INTEGER NOT NULL DEFAULT 0,
        refusal_outcome TEXT,
        failure_class TEXT,
        quality_flags TEXT
      );
      CREATE INDEX IF NOT EXISTS events_request_idx ON events(request_id);
      CREATE INDEX IF NOT EXISTS events_parent_idx ON events(parent_id);
      CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp_ms);
      CREATE INDEX IF NOT EXISTS events_refusal_timestamp_idx
        ON events(timestamp_ms) WHERE refusal_outcome IS NOT NULL;
      CREATE TABLE IF NOT EXISTS occurrences (
        source_id TEXT NOT NULL REFERENCES files(source_id) ON DELETE CASCADE,
        line_offset INTEGER NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
        PRIMARY KEY(source_id, line_offset)
      );
      CREATE INDEX IF NOT EXISTS occurrences_event_idx ON occurrences(event_id);
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        duration_ms INTEGER,
        output_tokens INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_creation_tokens INTEGER NOT NULL,
        family TEXT NOT NULL,
        family_known INTEGER NOT NULL DEFAULT 1,
        stratum INTEGER NOT NULL,
        tokens_per_second REAL,
        provisional INTEGER NOT NULL,
        quality_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_finished_idx ON requests(finished_at);
      CREATE INDEX IF NOT EXISTS requests_family_idx ON requests(family);
      CREATE INDEX IF NOT EXISTS requests_included_idx ON requests(request_id)
        WHERE quality_reason IS NULL AND provisional = 0;
      CREATE TABLE IF NOT EXISTS monitored_roots (
        root_id TEXT PRIMARY KEY,
        priority INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS request_history (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        duration_ms INTEGER,
        output_tokens INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_creation_tokens INTEGER NOT NULL,
        family TEXT NOT NULL,
        family_known INTEGER NOT NULL DEFAULT 1,
        stratum INTEGER NOT NULL,
        tokens_per_second REAL,
        provisional INTEGER NOT NULL DEFAULT 0,
        quality_reason TEXT,
        archived_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS request_history_finished_idx ON request_history(finished_at);
      CREATE INDEX IF NOT EXISTS request_history_family_idx ON request_history(family);
      -- Both partial indexes cover the measured-request predicate exactly. They
      -- are created unconditionally on every open because getMeasuredRequestCount
      -- names them in an INDEXED BY clause.
      CREATE INDEX IF NOT EXISTS request_history_included_idx ON request_history(request_id)
        WHERE quality_reason IS NULL AND provisional = 0;
      CREATE TABLE IF NOT EXISTS refusal_history (
        event_id TEXT PRIMARY KEY,
        request_id TEXT,
        session_id TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        refusal_outcome TEXT NOT NULL,
        safeguard INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS refusal_history_timestamp_idx ON refusal_history(timestamp_ms);
      CREATE TABLE IF NOT EXISTS failure_history (
        event_id TEXT PRIMARY KEY,
        request_id TEXT,
        session_id TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        failure_class TEXT NOT NULL,
        archived_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS failure_history_timestamp_idx ON failure_history(timestamp_ms);
      CREATE TABLE IF NOT EXISTS quota_samples (
        window TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        used_percentage REAL NOT NULL,
        resets_at INTEGER NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(window, observed_at, model)
      );
    `);
    const eventColumns = this.db.pragma('table_info(events)') as Array<{ name: string }>;
    if (eventColumns.some(({ name }) => name === 'refusal_category')) {
      this.db.exec('ALTER TABLE events DROP COLUMN refusal_category');
    }
    const version = Number(this.db.pragma('user_version', { simple: true })) || 0;
    this.addColumnIfMissing('files', 'root_id', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('events', 'failure_class', 'TEXT');
    // Samples written before per-model tracking carry no model and stay visible
    // through the overall windows on QuotaResponse alone.
    this.addColumnIfMissing('quota_samples', 'model', 'TEXT');
    // `model` joined the primary key when per-model tracking landed: under the
    // old (window, observed_at) key, INSERT OR REPLACE silently deleted a
    // different model's sample that landed in the same millisecond. A nullable
    // key column would not fix that either, because NULLs never conflict in
    // SQLite, so repeated unattributed samples would duplicate instead of
    // replace. Unattributed samples are therefore stored as '' and getQuota's
    // per-model breakdown filters them out; the overall windows keep them.
    const quotaColumns = this.db.pragma('table_info(quota_samples)') as Array<{
      name: string;
      pk: number;
    }>;
    if ((quotaColumns.find(({ name }) => name === 'model')?.pk ?? 0) === 0) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE quota_samples_widened (
            window TEXT NOT NULL,
            observed_at INTEGER NOT NULL,
            used_percentage REAL NOT NULL,
            resets_at INTEGER NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(window, observed_at, model)
          );
          INSERT INTO quota_samples_widened(window, observed_at, used_percentage, resets_at, model)
            SELECT window, observed_at, used_percentage, resets_at, COALESCE(model, '')
            FROM quota_samples;
          DROP TABLE quota_samples;
          ALTER TABLE quota_samples_widened RENAME TO quota_samples;
        `);
      })();
    }
    // Defaulting to "the family is real" matches every row written before the
    // column existed: `family` has always been non-null, so an older index has
    // no rows that are known to name no model. The next rebuild decides the
    // flag from the events themselves.
    this.addColumnIfMissing('requests', 'family_known', 'INTEGER NOT NULL DEFAULT 1');
    this.addColumnIfMissing('request_history', 'family_known', 'INTEGER NOT NULL DEFAULT 1');
    // An archived refusal used to recover this flag by joining `failure_history`.
    // Carrying the derived value across once keeps rows whose transcript has
    // rotated away deduplicating exactly as they did before, and is the last
    // read of that join. Rows archived from now on store the flag directly.
    if (this.addColumnIfMissing('refusal_history', 'safeguard', 'INTEGER NOT NULL DEFAULT 0')) {
      this.db.exec(`
        UPDATE refusal_history SET safeguard = 1
        WHERE EXISTS (
          SELECT 1 FROM failure_history archived
          WHERE archived.event_id = refusal_history.event_id
            AND archived.failure_class = 'safeguard_block'
        )
      `);
    }
    // The invalidation and the version bump commit together. Recording the
    // version first would let a crash in between leave an index that believes
    // it is current while every transcript still needs re-reading, and the new
    // column would stay empty forever.
    this.db.transaction(() => {
      if (version < 3) {
        // `failure_class` is derived per event, so it can only appear by
        // reading the transcripts again. Ingest upserts, so that re-read
        // repairs the rows in place; nothing is deleted and the archived
        // history self-heals its stale quality reasons on the next rebuild.
        this.invalidateFileCheckpoints();
      }
      this.db.pragma('user_version = 3');
    })();
    // Created after the column so an upgraded database can index it too.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS events_failure_timestamp_idx
        ON events(timestamp_ms) WHERE failure_class IS NOT NULL;
      -- Also after the quota_samples rebuild, which drops the old table and
      -- every index on it. Ordered (model, window, observed_at) so getQuota's
      -- per-model latest-sample lookup reads it as a covering index instead of
      -- sorting the whole table per quota request.
      CREATE INDEX IF NOT EXISTS quota_samples_model_window_idx
        ON quota_samples(model, window, observed_at);
    `);
    this.db.pragma('optimize');
  }

  /**
   * Adds a column an older index predates, reporting whether it was missing so
   * a caller can backfill it. `table`, `column` and `definition` are internal
   * literals from `migrate` alone, never user input, so interpolating them is
   * safe.
   */
  private addColumnIfMissing(table: string, column: string, definition: string): boolean {
    const columns = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (columns.some(({ name }) => name === column)) return false;
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (error) {
      // Two processes opening the same file can both pass the check above and
      // race the ALTER. Whoever loses sees the winner's column; report it as
      // added so the caller still runs its (idempotent) backfill.
      const after = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
      if (!after.some(({ name }) => name === column)) throw error;
    }
    return true;
  }

  close(): void {
    this.db.close();
  }

  digest(value: string): string {
    return createHmac('sha256', this.#key).update(value).digest('base64url');
  }

  sourceId(filePath: string): string {
    return this.digest(`source:${filePath}`);
  }

  rootId(rootPath: string): string {
    return this.digest(`root:${rootPath}`);
  }

  syncRoots(rootIds: readonly string[]): void {
    const update = this.db.transaction(() => {
      this.db.prepare('UPDATE monitored_roots SET enabled = 0').run();
      const upsert = this.db.prepare(`
        INSERT INTO monitored_roots(root_id, priority, enabled) VALUES (?, ?, 1)
        ON CONFLICT(root_id) DO UPDATE SET priority=excluded.priority, enabled=1
      `);
      rootIds.forEach((rootId, priority) => upsert.run(rootId, priority));
    });
    update();
  }

  getFileCheckpoint(sourceId: string): FileCheckpoint | null {
    const row = this.db.prepare('SELECT * FROM files WHERE source_id = ?').get(sourceId) as
      Record<string, number | string> | undefined;
    if (!row) return null;
    return {
      sourceId: String(row.source_id),
      rootId: String(row.root_id),
      identity: String(row.identity),
      size: Number(row.size),
      offset: Number(row.offset),
      mtimeMs: Number(row.mtime_ms),
      tailHash: String(row.tail_hash),
      rowsRead: Number(row.rows_read),
      invalidRows: Number(row.invalid_rows),
    };
  }

  listSourceIds(): string[] {
    return (
      this.db.prepare('SELECT source_id FROM files').all() as Array<{ source_id: string }>
    ).map(({ source_id }) => source_id);
  }

  listSources(): StoredSource[] {
    return (
      this.db.prepare('SELECT source_id, root_id FROM files').all() as Array<{
        source_id: string;
        root_id: string;
      }>
    ).map((row) => ({ sourceId: row.source_id, rootId: row.root_id }));
  }

  assignSourceRoot(sourceId: string, rootId: string): boolean {
    return (
      this.db
        .prepare('UPDATE files SET root_id = ? WHERE source_id = ? AND root_id <> ?')
        .run(rootId, sourceId, rootId).changes > 0
    );
  }

  applyFileScan(options: {
    checkpoint: FileCheckpoint;
    events: readonly ScannedEvent[];
    replace: boolean;
  }): void {
    const insertFile = this.db.prepare(`
      INSERT INTO files(source_id, root_id, identity, size, offset, mtime_ms, tail_hash, rows_read, invalid_rows)
      VALUES (@sourceId, @rootId, @identity, @size, @offset, @mtimeMs, @tailHash, @rowsRead, @invalidRows)
      ON CONFLICT(source_id) DO UPDATE SET
        root_id=excluded.root_id, identity=excluded.identity, size=excluded.size, offset=excluded.offset,
        mtime_ms=excluded.mtime_ms, tail_hash=excluded.tail_hash,
        rows_read=excluded.rows_read, invalid_rows=excluded.invalid_rows
    `);
    // Re-parsing a line is deterministic and `event_id` is a content-addressed
    // digest, so writing the derived columns again is idempotent by
    // construction. This makes ingest last-writer-wins where `INSERT OR IGNORE`
    // was implicitly first-writer-wins, which is what lets a newly derived
    // column be backfilled by re-reading transcripts instead of wiping the
    // index and rebuilding it from empty.
    const insertEvent = this.db.prepare(`
      INSERT INTO events(
        event_id, parent_id, request_id, session_id, timestamp_ms, type, model,
        output_tokens, input_tokens, cache_read_tokens, cache_creation_tokens,
        synthetic, refusal_outcome, failure_class, quality_flags
      ) VALUES (
        @eventId, @parentId, @requestId, @sessionId, @timestampMs, @type, @model,
        @outputTokens, @inputTokens, @cacheReadTokens, @cacheCreationTokens,
        @synthetic, @refusalOutcome, @failureClass, @qualityFlags
      )
      ON CONFLICT(event_id) DO UPDATE SET
        parent_id=excluded.parent_id, request_id=excluded.request_id,
        session_id=excluded.session_id, timestamp_ms=excluded.timestamp_ms,
        type=excluded.type, model=excluded.model,
        output_tokens=excluded.output_tokens, input_tokens=excluded.input_tokens,
        cache_read_tokens=excluded.cache_read_tokens,
        cache_creation_tokens=excluded.cache_creation_tokens,
        synthetic=excluded.synthetic, refusal_outcome=excluded.refusal_outcome,
        failure_class=excluded.failure_class, quality_flags=excluded.quality_flags
    `);
    const insertOccurrence = this.db.prepare(
      'INSERT OR REPLACE INTO occurrences(source_id, line_offset, event_id) VALUES (?, ?, ?)',
    );

    this.db.transaction(() => {
      if (options.replace) this.archiveStableInternal(Date.now());
      // The FK requires the file row to exist before occurrences are inserted.
      insertFile.run(options.checkpoint);
      if (options.replace) {
        this.db
          .prepare('DELETE FROM occurrences WHERE source_id = ?')
          .run(options.checkpoint.sourceId);
        this.deleteOrphanEvents();
      }
      for (const scanned of options.events) {
        insertEvent.run({ ...scanned.event, synthetic: scanned.event.synthetic ? 1 : 0 });
        insertOccurrence.run(
          options.checkpoint.sourceId,
          scanned.lineOffset,
          scanned.event.eventId,
        );
      }
    })();
    // Ingest changes the file, event and occurrence counts that the data
    // quality summary reports, even though it leaves `requests` for the rebuild
    // that follows it.
    this.advanceRevision();
  }

  retractSource(sourceId: string, nowMs = Date.now()): boolean {
    return this.retractSources([sourceId], nowMs);
  }

  retractSources(sourceIds: readonly string[], nowMs = Date.now()): boolean {
    if (sourceIds.length === 0) return false;
    const result = this.db.transaction(() => {
      const archived = this.archiveStableInternal(nowMs);
      const remove = this.db.prepare('DELETE FROM files WHERE source_id = ?');
      let changes = 0;
      for (const sourceId of new Set(sourceIds)) changes += remove.run(sourceId).changes;
      if (changes > 0) this.deleteOrphanEvents();
      return { sources: changes, archived };
    })();
    const changed =
      result.sources > 0 ||
      result.archived.requests > 0 ||
      result.archived.refusals > 0 ||
      result.archived.failures > 0;
    if (changed) this.advanceRevision();
    return changed;
  }

  /**
   * Forces the next scan to read every indexed transcript again from its first
   * byte and upsert the events in place. This is how a newly derived event
   * column is backfilled without deleting anything: the existing rows stay
   * queryable for the whole re-read instead of the dashboard sitting empty
   * until a full re-ingest finishes.
   *
   * Zeroing `offset` alone re-reads nothing, because `Scanner.scanFile` returns
   * early when the recorded size and mtime still match the file on disk, so
   * those have to stop matching; -1 cannot collide with a real stat. The tail
   * hash describes the offset it was taken at and goes with it. The row
   * counters reset because the append path adds each scan's rows to the stored
   * totals, which would otherwise count every re-read row a second time.
   */
  invalidateFileCheckpoints(): void {
    this.db
      .prepare(
        `UPDATE files SET size = -1, offset = 0, mtime_ms = -1, tail_hash = '',
           rows_read = 0, invalid_rows = 0`,
      )
      .run();
    this.advanceRevision();
  }

  resetLive(nowMs = Date.now()): void {
    this.db.transaction(() => {
      this.archiveStableInternal(nowMs);
      this.db.prepare('DELETE FROM occurrences').run();
      this.db.prepare('DELETE FROM events').run();
      this.db.prepare('DELETE FROM files').run();
      this.db.prepare('DELETE FROM requests').run();
    })();
    this.advanceRevision();
  }

  private deleteOrphanEvents(): void {
    this.db
      .prepare(
        `
      DELETE FROM events
      WHERE NOT EXISTS (SELECT 1 FROM occurrences WHERE occurrences.event_id = events.event_id)
    `,
      )
      .run();
  }

  /**
   * Prunes archived refusals whose live event no longer reports one, then
   * archives every stable live refusal.
   *
   * `safeguard` is stored rather than recovered later by joining
   * `failure_history` for the same event. That join forced the two history
   * tables to archive and prune in lockstep and made the failure axis retain
   * rows it can never report, purely so the refusal axis could read them back.
   */
  private archiveRefusals(nowMs: number, cutoff: number): number {
    const removed = this.db
      .prepare(
        `
      DELETE FROM refusal_history
      WHERE EXISTS (
        SELECT 1 FROM events live
        WHERE live.event_id = refusal_history.event_id
          AND live.refusal_outcome IS NULL
          AND live.timestamp_ms IS NOT NULL
          AND live.timestamp_ms <= @cutoff
      )
    `,
      )
      .run({ cutoff });
    const archived = this.db
      .prepare(
        `
      INSERT INTO refusal_history(
        event_id, request_id, session_id, timestamp_ms, refusal_outcome, safeguard,
        archived_at, updated_at
      )
      SELECT event_id, request_id, session_id, timestamp_ms, refusal_outcome,
        CASE WHEN failure_class = 'safeguard_block' THEN 1 ELSE 0 END, @nowMs, @nowMs
      FROM events
      WHERE refusal_outcome IS NOT NULL AND timestamp_ms IS NOT NULL AND timestamp_ms <= @cutoff
      ON CONFLICT(event_id) DO UPDATE SET
        request_id=excluded.request_id, session_id=excluded.session_id,
        timestamp_ms=excluded.timestamp_ms, refusal_outcome=excluded.refusal_outcome,
        safeguard=excluded.safeguard, updated_at=excluded.updated_at
      WHERE refusal_history.request_id IS NOT excluded.request_id
        OR refusal_history.session_id IS NOT excluded.session_id
        OR refusal_history.timestamp_ms IS NOT excluded.timestamp_ms
        OR refusal_history.refusal_outcome IS NOT excluded.refusal_outcome
        OR refusal_history.safeguard IS NOT excluded.safeguard
    `,
      )
      .run({ nowMs, cutoff });
    return removed.changes + archived.changes;
  }

  /**
   * Prunes archived failures whose live event no longer qualifies, then
   * archives every stable live platform fault.
   *
   * Only platform faults are archived, because only those can be reported:
   * `safeguard_block` reaches the dashboard as a refusal and `client` is a
   * local fault. The prune is the exact negation of that predicate, so a class
   * corrected away — and the two non-platform classes an older index archived
   * while the refusal axis still read them back — are removed on the next pass.
   */
  private archiveFailures(nowMs: number, cutoff: number): number {
    const classes = Object.fromEntries(
      PLATFORM_FAILURE_CLASSES.map((failureClass, index) => [`class${index}`, failureClass]),
    );
    const platform = PLATFORM_FAILURE_CLASSES.map((_, index) => `@class${index}`).join(', ');
    const removed = this.db
      .prepare(
        `
      DELETE FROM failure_history
      WHERE EXISTS (
        SELECT 1 FROM events live
        WHERE live.event_id = failure_history.event_id
          AND (live.failure_class IS NULL OR live.failure_class NOT IN (${platform}))
          AND live.timestamp_ms IS NOT NULL
          AND live.timestamp_ms <= @cutoff
      )
    `,
      )
      .run({ ...classes, cutoff });
    const archived = this.db
      .prepare(
        `
      INSERT INTO failure_history(
        event_id, request_id, session_id, timestamp_ms, failure_class, archived_at, updated_at
      )
      SELECT event_id, request_id, session_id, timestamp_ms, failure_class, @nowMs, @nowMs
      FROM events
      WHERE failure_class IN (${platform}) AND timestamp_ms IS NOT NULL AND timestamp_ms <= @cutoff
      ON CONFLICT(event_id) DO UPDATE SET
        request_id=excluded.request_id, session_id=excluded.session_id,
        timestamp_ms=excluded.timestamp_ms, failure_class=excluded.failure_class,
        updated_at=excluded.updated_at
      WHERE failure_history.request_id IS NOT excluded.request_id
        OR failure_history.session_id IS NOT excluded.session_id
        OR failure_history.timestamp_ms IS NOT excluded.timestamp_ms
        OR failure_history.failure_class IS NOT excluded.failure_class
    `,
      )
      .run({ ...classes, nowMs, cutoff });
    return removed.changes + archived.changes;
  }

  private archiveStableInternal(nowMs: number): {
    requests: number;
    refusals: number;
    failures: number;
  } {
    const cutoff = nowMs - HISTORY_STABILITY_MS;
    const requestResult = this.db
      .prepare(
        `
      INSERT INTO request_history(
        request_id, session_id, started_at, finished_at, duration_ms, output_tokens,
        input_tokens, cache_read_tokens, cache_creation_tokens, family, family_known,
        stratum, tokens_per_second, provisional, quality_reason, archived_at, updated_at
      )
      SELECT request_id, session_id, started_at, finished_at, duration_ms, output_tokens,
        input_tokens, cache_read_tokens, cache_creation_tokens, family, family_known,
        stratum, tokens_per_second, 0, quality_reason, @nowMs, @nowMs
      FROM requests
      WHERE finished_at IS NOT NULL AND finished_at <= @cutoff
      ON CONFLICT(request_id) DO UPDATE SET
        session_id=excluded.session_id, started_at=excluded.started_at,
        finished_at=excluded.finished_at, duration_ms=excluded.duration_ms,
        output_tokens=excluded.output_tokens, input_tokens=excluded.input_tokens,
        cache_read_tokens=excluded.cache_read_tokens,
        cache_creation_tokens=excluded.cache_creation_tokens,
        family=excluded.family, family_known=excluded.family_known,
        stratum=excluded.stratum,
        tokens_per_second=excluded.tokens_per_second, provisional=0,
        quality_reason=excluded.quality_reason, updated_at=excluded.updated_at
      WHERE request_history.session_id IS NOT excluded.session_id
        OR request_history.started_at IS NOT excluded.started_at
        OR request_history.finished_at IS NOT excluded.finished_at
        OR request_history.duration_ms IS NOT excluded.duration_ms
        OR request_history.output_tokens IS NOT excluded.output_tokens
        OR request_history.input_tokens IS NOT excluded.input_tokens
        OR request_history.cache_read_tokens IS NOT excluded.cache_read_tokens
        OR request_history.cache_creation_tokens IS NOT excluded.cache_creation_tokens
        OR request_history.family IS NOT excluded.family
        OR request_history.family_known IS NOT excluded.family_known
        OR request_history.stratum IS NOT excluded.stratum
        OR request_history.tokens_per_second IS NOT excluded.tokens_per_second
        OR request_history.provisional IS NOT 0
        OR request_history.quality_reason IS NOT excluded.quality_reason
    `,
      )
      .run({ nowMs, cutoff });
    return {
      requests: requestResult.changes,
      refusals: this.archiveRefusals(nowMs, cutoff),
      failures: this.archiveFailures(nowMs, cutoff),
    };
  }

  archiveStable(nowMs = Date.now()): boolean {
    const changed = this.db.transaction(() => this.archiveStableInternal(nowMs))();
    const archived = changed.requests > 0 || changed.refusals > 0 || changed.failures > 0;
    if (archived) this.advanceRevision();
    return archived;
  }

  rebuildRequests(nowMs = Date.now(), idleMs = 120_000): void {
    type EventRow = {
      event_id: string;
      parent_id: string | null;
      request_id: string;
      session_id: string;
      timestamp_ms: number | null;
      parent_timestamp_ms: number | null;
      model: string | null;
      output_tokens: number;
      input_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      synthetic: number;
      failure_class: string | null;
    };
    const assistantRows = this.db
      .prepare(
        `
        SELECT event.event_id, event.parent_id, event.request_id, event.session_id,
          event.timestamp_ms, parent.timestamp_ms parent_timestamp_ms, event.model,
          event.output_tokens, event.input_tokens, event.cache_read_tokens,
          event.cache_creation_tokens, event.synthetic, event.failure_class
        FROM events event
        LEFT JOIN events parent ON parent.event_id = event.parent_id
        WHERE event.type = 'assistant' AND event.request_id IS NOT NULL
        ORDER BY event.request_id, event.timestamp_ms, event.event_id
      `,
      )
      .all() as EventRow[];
    const grouped = new Map<string, EventRow[]>();
    for (const row of assistantRows) {
      const group = grouped.get(row.request_id) ?? [];
      group.push(row);
      grouped.set(row.request_id, group);
    }

    const insert = this.db.prepare(`
      INSERT INTO requests(
        request_id, session_id, started_at, finished_at, duration_ms, output_tokens,
        input_tokens, cache_read_tokens, cache_creation_tokens, family, family_known,
        stratum, tokens_per_second, provisional, quality_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.transaction(() => {
      this.db.prepare('DELETE FROM requests').run();
      for (const [requestId, events] of grouped) {
        const itemIds = new Set(events.map(({ event_id }) => event_id));
        const timestamps = events
          .map(({ timestamp_ms }) => timestamp_ms)
          .filter((value): value is number => value != null && Number.isFinite(value));
        const roots = events.filter(
          ({ parent_id }) => parent_id == null || !itemIds.has(parent_id),
        );
        const starts = roots
          .map(({ parent_timestamp_ms }) => parent_timestamp_ms)
          .filter((value): value is number => value != null && Number.isFinite(value));
        const startedAt = starts.length > 0 ? Math.min(...starts) : null;
        const finishedAt = timestamps.length > 0 ? Math.max(...timestamps) : null;
        const durationMs = startedAt == null || finishedAt == null ? null : finishedAt - startedAt;
        const outputTokens = Math.max(...events.map(({ output_tokens }) => output_tokens), 0);
        const inputTokens = Math.max(...events.map(({ input_tokens }) => input_tokens), 0);
        const cacheReadTokens = Math.max(
          ...events.map(({ cache_read_tokens }) => cache_read_tokens),
          0,
        );
        const cacheCreationTokens = Math.max(
          ...events.map(({ cache_creation_tokens }) => cache_creation_tokens),
          0,
        );
        // `events.model` is already a normalized family, or NULL on a row that
        // named no model at all (an API-error row reports `<synthetic>`). The
        // placeholder keeps the column non-null, and `family_known` records
        // whether it stands for a real attribution rather than being inferred
        // later from an unrelated enum.
        //
        // Re-normalizing is not for that: indexes written before 0.1.5 stored
        // the raw model id, and the in-place upgrade lets those rows survive
        // instead of deleting them, so one can still reach this line until its
        // transcript has been read again.
        const named = events.find(({ model }) => model)?.model ?? null;
        const family = named === null ? 'other' : normalizeModelFamily(named);
        const familyKnown = named !== null;
        let qualityReason: string | null = null;
        // A transport failure shares its request id with the partial output that
        // preceded it, so the pair must never be measured as throughput.
        if (events.some(({ failure_class }) => failure_class != null)) qualityReason = 'api_error';
        else if (events.some(({ synthetic }) => synthetic !== 0)) qualityReason = 'synthetic';
        else if (timestamps.length !== events.length) qualityReason = 'invalid_time';
        else if (starts.length === 0) qualityReason = 'missing_parent';
        else if (outputTokens <= 0) qualityReason = 'non_positive_tokens';
        else if (durationMs == null || durationMs <= 0) qualityReason = 'invalid_time';
        else if (durationMs < 100) qualityReason = 'sub_100ms';
        else if (durationMs >= 3_600_000) qualityReason = 'hour_scale';
        const tokensPerSecond =
          qualityReason == null && durationMs != null ? outputTokens / (durationMs / 1_000) : null;
        const provisional = finishedAt != null && finishedAt >= nowMs - idleMs;

        insert.run(
          requestId,
          events[0].session_id,
          startedAt,
          finishedAt,
          durationMs,
          outputTokens,
          inputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          family,
          familyKnown ? 1 : 0,
          outputSizeStratum(outputTokens),
          tokensPerSecond,
          provisional ? 1 : 0,
          qualityReason,
        );
      }
      this.archiveStableInternal(nowMs);
    })();
    this.advanceRevision();
  }

  /**
   * Advances the revision that cached views are keyed on. Every write that
   * changes something those views report — request rows, archived rows, events
   * or file checkpoints — has to pass through here, because a write that
   * skipped it would let a cache serve numbers the database no longer holds.
   */
  private advanceRevision(): void {
    this.#requestRevision += 1;
  }

  getRequestRevision(): number {
    return this.#requestRevision;
  }

  getRequests(): StoredRequest[] {
    type Row = {
      request_id: string;
      session_id: string;
      started_at: number | null;
      finished_at: number | null;
      duration_ms: number | null;
      output_tokens: number;
      input_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      family: ModelFamily;
      family_known: number;
      stratum: number;
      tokens_per_second: number | null;
      provisional: number;
      quality_reason: string | null;
    };
    return (
      this.db
        .prepare(
          `
      SELECT request_id, session_id, started_at, finished_at, duration_ms, output_tokens,
        input_tokens, cache_read_tokens, cache_creation_tokens, family, family_known,
        stratum, tokens_per_second, provisional, quality_reason
      FROM requests
      UNION ALL
      SELECT history.request_id, history.session_id, history.started_at, history.finished_at,
        history.duration_ms, history.output_tokens, history.input_tokens,
        history.cache_read_tokens, history.cache_creation_tokens, history.family,
        history.family_known, history.stratum, history.tokens_per_second,
        history.provisional, history.quality_reason
      FROM request_history history
      WHERE NOT EXISTS (SELECT 1 FROM requests live WHERE live.request_id = history.request_id)
      ORDER BY finished_at
    `,
        )
        .all() as Row[]
    ).map((row) => ({
      requestId: row.request_id,
      sessionId: row.session_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      outputTokens: row.output_tokens,
      inputTokens: row.input_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      family: row.family,
      familyKnown: row.family_known !== 0,
      stratum: row.stratum,
      tokensPerSecond: row.tokens_per_second,
      provisional: row.provisional !== 0,
      qualityReason: row.quality_reason,
    }));
  }

  getRefusals(): StoredRefusal[] {
    type Row = {
      event_id: string;
      request_id: string | null;
      session_id: string;
      timestamp_ms: number;
      refusal_outcome: StoredRefusal['outcome'];
    };
    // The classifier and the API safeguard can both report the same request, in
    // which case the classifier row wins because it carries the outcome detail.
    // That is the only merge: two classifier refusals on one request are two
    // distinct signals, and so are two safeguard rows. Rows without a request id
    // are never merged, since a null id matches nothing.
    return (
      this.db
        .prepare(
          `
          WITH combined AS MATERIALIZED (
            SELECT event_id, request_id, session_id, timestamp_ms, refusal_outcome,
              CASE WHEN failure_class = 'safeguard_block' THEN 1 ELSE 0 END safeguard
            FROM events WHERE refusal_outcome IS NOT NULL AND timestamp_ms IS NOT NULL
            UNION ALL
            SELECT history.event_id, history.request_id, history.session_id,
              history.timestamp_ms, history.refusal_outcome, history.safeguard
            FROM refusal_history history
            WHERE NOT EXISTS (SELECT 1 FROM events live WHERE live.event_id = history.event_id)
          )
          SELECT refusal.event_id, refusal.request_id, refusal.session_id,
            refusal.timestamp_ms, refusal.refusal_outcome
          FROM combined refusal
          WHERE refusal.safeguard = 0
            OR refusal.request_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM combined classifier
              WHERE classifier.request_id = refusal.request_id AND classifier.safeguard = 0
            )
          ORDER BY refusal.timestamp_ms
        `,
        )
        .all() as Row[]
    ).map((row) => ({
      eventId: row.event_id,
      requestId: row.request_id,
      sessionId: row.session_id,
      timestampMs: row.timestamp_ms,
      outcome: row.refusal_outcome,
    }));
  }

  getFailures(): StoredFailure[] {
    type Row = {
      event_id: string;
      request_id: string | null;
      session_id: string;
      timestamp_ms: number;
      failure_class: StoredFailure['failureClass'];
    };
    const placeholders = PLATFORM_FAILURE_CLASSES.map(() => '?').join(', ');
    return (
      this.db
        .prepare(
          `
          SELECT event_id, request_id, session_id, timestamp_ms, failure_class
          FROM events
          WHERE failure_class IN (${placeholders}) AND timestamp_ms IS NOT NULL
          UNION ALL
          SELECT history.event_id, history.request_id, history.session_id,
            history.timestamp_ms, history.failure_class
          FROM failure_history history
          WHERE history.failure_class IN (${placeholders})
            AND NOT EXISTS (SELECT 1 FROM events live WHERE live.event_id = history.event_id)
          ORDER BY timestamp_ms
        `,
        )
        .all(...PLATFORM_FAILURE_CLASSES, ...PLATFORM_FAILURE_CLASSES) as Row[]
    ).map((row) => ({
      eventId: row.event_id,
      requestId: row.request_id,
      sessionId: row.session_id,
      timestampMs: row.timestamp_ms,
      failureClass: row.failure_class,
    }));
  }

  /**
   * Counts the requests that were actually measured, which is the denominator
   * both interruption rates divide by. `getDataQuality` reports the same number
   * but only as a by-product of four other aggregates, and callers that want
   * nothing else should not pay for them.
   *
   * `INDEXED BY` is a correctness-neutral hint the planner needs rather than a
   * preference: both partial indexes cover this predicate exactly, but for a
   * bare COUNT the planner scores them no better than a full table scan and
   * keeps the scan. Naming them is roughly 2.5x faster on a full-size index.
   * `migrate` creates both on every open, so they are always there to name.
   */
  getMeasuredRequestCount(): number {
    return (
      this.db
        .prepare(
          `
        SELECT
          (SELECT COUNT(*) FROM requests INDEXED BY requests_included_idx
            WHERE quality_reason IS NULL AND provisional = 0)
          + (SELECT COUNT(*) FROM request_history history
              INDEXED BY request_history_included_idx
              WHERE history.quality_reason IS NULL AND history.provisional = 0
                AND NOT EXISTS (
                  SELECT 1 FROM requests live WHERE live.request_id = history.request_id
                ))
          AS count
      `,
        )
        .get() as { count: number }
    ).count;
  }

  getDataQuality(): DataQualitySummary {
    // The dashboard asks for the overview and the data-quality panel in one
    // round trip, so a single-threaded server would otherwise run this twice
    // per refresh. Every write that changes anything counted below advances the
    // index revision, so a hit here can only serve numbers still on disk.
    const revision = this.#requestRevision;
    if (this.#dataQuality?.revision === revision) {
      const cached = this.#dataQuality.summary;
      return { ...cached, exclusions: { ...cached.exclusions } };
    }
    const files = this.db
      .prepare(
        'SELECT COUNT(*) files, COALESCE(SUM(rows_read), 0) rows, COALESCE(SUM(invalid_rows), 0) invalid FROM files',
      )
      .get() as { files: number; rows: number; invalid: number };
    const events = this.db
      .prepare(
        `
        SELECT COUNT(*) events,
          COALESCE(SUM(CASE WHEN quality_flags = 'uuid_missing' THEN 1 ELSE 0 END), 0) uuid_missing
        FROM events
      `,
      )
      .get() as { events: number; uuid_missing: number };
    const occurrences = this.db.prepare('SELECT COUNT(*) count FROM occurrences').get() as {
      count: number;
    };
    const requests = this.db
      .prepare(
        `
        WITH effective AS (
          SELECT request_id, quality_reason, provisional FROM requests
          UNION ALL
          SELECT history.request_id, history.quality_reason, history.provisional
          FROM request_history history
          WHERE NOT EXISTS (SELECT 1 FROM requests live WHERE live.request_id = history.request_id)
        )
        SELECT quality_reason, provisional, COUNT(*) count
        FROM effective GROUP BY quality_reason, provisional
      `,
      )
      .all() as Array<{
      quality_reason: string | null;
      provisional: number;
      count: number;
    }>;
    const exclusions: Record<string, number> = {};
    let includedRequests = 0;
    let requestCount = 0;
    for (const row of requests) {
      requestCount += row.count;
      if (row.quality_reason != null) {
        exclusions[row.quality_reason] = (exclusions[row.quality_reason] ?? 0) + row.count;
      } else if (row.provisional !== 0) {
        exclusions.provisional = (exclusions.provisional ?? 0) + row.count;
      } else {
        includedRequests += row.count;
      }
    }
    const archivedRequests = (
      this.db.prepare('SELECT COUNT(*) count FROM request_history').get() as { count: number }
    ).count;
    const archivedRefusals = (
      this.db.prepare('SELECT COUNT(*) count FROM refusal_history').get() as { count: number }
    ).count;
    const summary: DataQualitySummary = {
      files: files.files,
      rows: files.rows,
      invalidRows: files.invalid,
      uniqueEvents: events.events,
      duplicateOccurrences: Math.max(0, occurrences.count - events.events),
      uuidMissing: events.uuid_missing,
      requests: requestCount,
      includedRequests,
      archivedRequests,
      archivedRefusals,
      exclusions,
    };
    this.#dataQuality = { revision, summary };
    return { ...summary, exclusions: { ...exclusions } };
  }

  setScanStatus(status: ScanStatus): void {
    this.#scanStatus = { ...status };
  }

  getScanStatus(): ScanStatus {
    return { ...this.#scanStatus };
  }

  recordQuotaSample(sample: QuotaSampleInput): void {
    const observedAt = toMillis(sample.observedAt ?? Date.now());
    if (!Number.isFinite(observedAt)) throw new TypeError('Invalid quota observation time');
    // The endpoint already sanitizes; direct database callers get the same
    // clamping so a stray long id can never land in the index. An absent model
    // becomes the '' sentinel so inserts never violate the NOT NULL key column.
    const rawModel = typeof sample.model === 'string' ? sample.model.trim() : '';
    const model = rawModel ? rawModel.slice(0, 64) : '';
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO quota_samples(window, observed_at, used_percentage, resets_at, model) VALUES (?, ?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const [window, value] of [
        ['five_hour', sample.fiveHour],
        ['seven_day', sample.sevenDay],
      ] as const) {
        if (!value) continue;
        const resetsAt = toMillis(value.resetsAt);
        if (!Number.isFinite(resetsAt) || !Number.isFinite(value.usedPercentage)) continue;
        insert.run(
          window,
          observedAt,
          Math.max(0, Math.min(100, value.usedPercentage)),
          resetsAt,
          model,
        );
      }
      // Retain enough history for reset-boundary diagnostics without unbounded growth.
      this.db
        .prepare('DELETE FROM quota_samples WHERE observed_at < ?')
        .run(observedAt - 90 * 86_400_000);
    })();
  }

  getQuota(now: Date = new Date()): QuotaResponse {
    type Row = {
      model: string;
      window: 'five_hour' | 'seven_day';
      observed_at: number;
      used_percentage: number;
      resets_at: number;
    };
    // The overall windows stay the latest sample per window across all models,
    // so pre-model rows and status lines without a model id keep surfacing.
    const overallRows = this.db
      .prepare(
        `
        SELECT q.model, q.window, q.observed_at, q.used_percentage, q.resets_at
        FROM quota_samples q
        JOIN (SELECT window, MAX(observed_at) latest FROM quota_samples GROUP BY window) latest
          ON latest.window = q.window AND latest.latest = q.observed_at
      `,
      )
      .all() as Row[];
    const modelRows = this.db
      .prepare(
        `
        SELECT q.model, q.window, q.observed_at, q.used_percentage, q.resets_at
        FROM quota_samples q
        JOIN (
          SELECT model, window, MAX(observed_at) latest
          FROM quota_samples
          WHERE model <> ''
          GROUP BY model, window
        ) latest
          ON latest.model = q.model AND latest.window = q.window AND latest.latest = q.observed_at
      `,
      )
      .all() as Row[];
    const format = (row: Row) => ({
      usedPercentage: row.used_percentage,
      resetsAt: new Date(row.resets_at).toISOString(),
      observedAt: new Date(row.observed_at).toISOString(),
      stale: now.getTime() - row.observed_at > 15 * 60_000 || now.getTime() >= row.resets_at,
    });
    const latest = (rows: Row[], window: Row['window']) =>
      rows.find((row) => row.window === window) ?? null;
    const overallFiveHour = latest(overallRows, 'five_hour');
    const overallSevenDay = latest(overallRows, 'seven_day');
    const fiveHour = overallFiveHour ? format(overallFiveHour) : null;
    const sevenDay = overallSevenDay ? format(overallSevenDay) : null;
    // Samples without a model id are stored under the '' sentinel and excluded
    // above; they belong to the overall windows only, and grouping them under
    // an invented label would invent a quota system that never sent one.
    const models = new Map<string, QuotaModelWindows>();
    for (const row of modelRows) {
      const entry = models.get(row.model) ?? { model: row.model, fiveHour: null, sevenDay: null };
      if (row.window === 'five_hour') entry.fiveHour = format(row);
      else entry.sevenDay = format(row);
      models.set(row.model, entry);
    }
    return {
      available: fiveHour != null || sevenDay != null,
      source: fiveHour != null || sevenDay != null ? 'statusline' : null,
      fiveHour,
      sevenDay,
      models: [...models.values()].sort((a, b) =>
        a.model < b.model ? -1 : a.model > b.model ? 1 : 0,
      ),
    };
  }
}
