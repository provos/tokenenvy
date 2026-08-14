import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { normalizeModelFamily, outputSizeStratum } from '../core/model';
import type { ParsedEvent } from '../core/parser';
import type { ModelFamily, QuotaResponse, ScanStatus } from '../types';

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

export interface QuotaSampleInput {
  fiveHour?: { usedPercentage: number; resetsAt: string | number | Date } | null;
  sevenDay?: { usedPercentage: number; resetsAt: string | number | Date } | null;
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
  revision: 0
};

function keyFor(options: DatabaseOptions): Buffer {
  if (options.hmacKey) return Buffer.isBuffer(options.hmacKey) ? options.hmacKey : Buffer.from(options.hmacKey);
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
  #scanStatus: ScanStatus = { ...EMPTY_SCAN_STATUS };

  constructor(options: DatabaseOptions | string) {
    const normalized = typeof options === 'string' ? { path: options } : options;
    this.#key = keyFor(normalized);
    if (normalized.path !== ':memory:') mkdirSync(dirname(normalized.path), { recursive: true, mode: 0o700 });
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
        stratum INTEGER NOT NULL,
        tokens_per_second REAL,
        provisional INTEGER NOT NULL,
        quality_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_finished_idx ON requests(finished_at);
      CREATE INDEX IF NOT EXISTS requests_family_idx ON requests(family);
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
        stratum INTEGER NOT NULL,
        tokens_per_second REAL,
        provisional INTEGER NOT NULL DEFAULT 0,
        quality_reason TEXT,
        archived_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS request_history_finished_idx ON request_history(finished_at);
      CREATE INDEX IF NOT EXISTS request_history_family_idx ON request_history(family);
      CREATE TABLE IF NOT EXISTS refusal_history (
        event_id TEXT PRIMARY KEY,
        request_id TEXT,
        session_id TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        refusal_outcome TEXT NOT NULL,
        archived_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS refusal_history_timestamp_idx ON refusal_history(timestamp_ms);
      CREATE TABLE IF NOT EXISTS quota_samples (
        window TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        used_percentage REAL NOT NULL,
        resets_at INTEGER NOT NULL,
        PRIMARY KEY(window, observed_at)
      );
    `);
    const fileColumns = this.db.pragma('table_info(files)') as Array<{ name: string }>;
    if (!fileColumns.some(({ name }) => name === 'root_id')) {
      this.db.exec("ALTER TABLE files ADD COLUMN root_id TEXT NOT NULL DEFAULT ''");
    }
    const eventColumns = this.db.pragma('table_info(events)') as Array<{ name: string }>;
    if (eventColumns.some(({ name }) => name === 'refusal_category')) {
      this.db.exec('ALTER TABLE events DROP COLUMN refusal_category');
    }
    this.db.pragma('user_version = 2');
    this.db.pragma('optimize');
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
      | Record<string, number | string>
      | undefined;
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
      invalidRows: Number(row.invalid_rows)
    };
  }

  listSourceIds(): string[] {
    return (this.db.prepare('SELECT source_id FROM files').all() as Array<{ source_id: string }>).map(
      ({ source_id }) => source_id
    );
  }

  listSources(): StoredSource[] {
    return (this.db.prepare('SELECT source_id, root_id FROM files').all() as Array<{
      source_id: string;
      root_id: string;
    }>).map((row) => ({ sourceId: row.source_id, rootId: row.root_id }));
  }

  assignSourceRoot(sourceId: string, rootId: string): boolean {
    return this.db.prepare('UPDATE files SET root_id = ? WHERE source_id = ? AND root_id <> ?')
      .run(rootId, sourceId, rootId).changes > 0;
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
    const insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO events(
        event_id, parent_id, request_id, session_id, timestamp_ms, type, subtype, model,
        output_tokens, input_tokens, cache_read_tokens, cache_creation_tokens,
        synthetic, refusal_outcome, quality_flags
      ) VALUES (
        @eventId, @parentId, @requestId, @sessionId, @timestampMs, @type, @subtype, @model,
        @outputTokens, @inputTokens, @cacheReadTokens, @cacheCreationTokens,
        @synthetic, @refusalOutcome, @qualityFlags
      )
    `);
    const insertOccurrence = this.db.prepare(
      'INSERT OR REPLACE INTO occurrences(source_id, line_offset, event_id) VALUES (?, ?, ?)'
    );

    this.db.transaction(() => {
      if (options.replace) this.archiveStableInternal(Date.now());
      // The FK requires the file row to exist before occurrences are inserted.
      insertFile.run(options.checkpoint);
      if (options.replace) {
        this.db.prepare('DELETE FROM occurrences WHERE source_id = ?').run(options.checkpoint.sourceId);
        this.deleteOrphanEvents();
      }
      for (const scanned of options.events) {
        insertEvent.run({ ...scanned.event, synthetic: scanned.event.synthetic ? 1 : 0 });
        insertOccurrence.run(options.checkpoint.sourceId, scanned.lineOffset, scanned.event.eventId);
      }
    })();
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
    const changed = result.sources > 0 || result.archived.requests > 0 || result.archived.refusals > 0;
    if (result.sources > 0 || result.archived.requests > 0) this.#requestRevision += 1;
    return changed;
  }

  resetLive(nowMs = Date.now()): void {
    this.db.transaction(() => {
      this.archiveStableInternal(nowMs);
      this.db.prepare('DELETE FROM occurrences').run();
      this.db.prepare('DELETE FROM events').run();
      this.db.prepare('DELETE FROM files').run();
      this.db.prepare('DELETE FROM requests').run();
    })();
    this.#requestRevision += 1;
  }

  private deleteOrphanEvents(): void {
    this.db.prepare(`
      DELETE FROM events
      WHERE NOT EXISTS (SELECT 1 FROM occurrences WHERE occurrences.event_id = events.event_id)
    `).run();
  }

  private archiveStableInternal(nowMs: number): { requests: number; refusals: number } {
    const cutoff = nowMs - HISTORY_STABILITY_MS;
    const requestResult = this.db.prepare(`
      INSERT INTO request_history(
        request_id, session_id, started_at, finished_at, duration_ms, output_tokens,
        input_tokens, cache_read_tokens, cache_creation_tokens, family, stratum,
        tokens_per_second, provisional, quality_reason, archived_at, updated_at
      )
      SELECT request_id, session_id, started_at, finished_at, duration_ms, output_tokens,
        input_tokens, cache_read_tokens, cache_creation_tokens, family, stratum,
        tokens_per_second, 0, quality_reason, @nowMs, @nowMs
      FROM requests
      WHERE finished_at IS NOT NULL AND finished_at <= @cutoff
      ON CONFLICT(request_id) DO UPDATE SET
        session_id=excluded.session_id, started_at=excluded.started_at,
        finished_at=excluded.finished_at, duration_ms=excluded.duration_ms,
        output_tokens=excluded.output_tokens, input_tokens=excluded.input_tokens,
        cache_read_tokens=excluded.cache_read_tokens,
        cache_creation_tokens=excluded.cache_creation_tokens,
        family=excluded.family, stratum=excluded.stratum,
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
        OR request_history.stratum IS NOT excluded.stratum
        OR request_history.tokens_per_second IS NOT excluded.tokens_per_second
        OR request_history.provisional IS NOT 0
        OR request_history.quality_reason IS NOT excluded.quality_reason
    `).run({ nowMs, cutoff });
    const removedRefusals = this.db.prepare(`
      DELETE FROM refusal_history
      WHERE EXISTS (
        SELECT 1 FROM events live
        WHERE live.event_id = refusal_history.event_id
          AND live.refusal_outcome IS NULL
          AND live.timestamp_ms IS NOT NULL
          AND live.timestamp_ms <= @cutoff
      )
    `).run({ cutoff });
    const refusalResult = this.db.prepare(`
      INSERT INTO refusal_history(
        event_id, request_id, session_id, timestamp_ms, refusal_outcome, archived_at, updated_at
      )
      SELECT event_id, request_id, session_id, timestamp_ms, refusal_outcome, @nowMs, @nowMs
      FROM events
      WHERE refusal_outcome IS NOT NULL AND timestamp_ms IS NOT NULL AND timestamp_ms <= @cutoff
      ON CONFLICT(event_id) DO UPDATE SET
        request_id=excluded.request_id, session_id=excluded.session_id,
        timestamp_ms=excluded.timestamp_ms, refusal_outcome=excluded.refusal_outcome,
        updated_at=excluded.updated_at
      WHERE refusal_history.request_id IS NOT excluded.request_id
        OR refusal_history.session_id IS NOT excluded.session_id
        OR refusal_history.timestamp_ms IS NOT excluded.timestamp_ms
        OR refusal_history.refusal_outcome IS NOT excluded.refusal_outcome
    `).run({ nowMs, cutoff });
    return {
      requests: requestResult.changes,
      refusals: removedRefusals.changes + refusalResult.changes
    };
  }

  archiveStable(nowMs = Date.now()): boolean {
    const changed = this.db.transaction(() => this.archiveStableInternal(nowMs))();
    if (changed.requests > 0) this.#requestRevision += 1;
    return changed.requests > 0 || changed.refusals > 0;
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
    };
    const assistantRows = this.db
      .prepare(`
        SELECT event.event_id, event.parent_id, event.request_id, event.session_id,
          event.timestamp_ms, parent.timestamp_ms parent_timestamp_ms, event.model,
          event.output_tokens, event.input_tokens, event.cache_read_tokens,
          event.cache_creation_tokens, event.synthetic
        FROM events event
        LEFT JOIN events parent ON parent.event_id = event.parent_id
        WHERE event.type = 'assistant' AND event.request_id IS NOT NULL
        ORDER BY event.request_id, event.timestamp_ms, event.event_id
      `)
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
        input_tokens, cache_read_tokens, cache_creation_tokens, family, stratum,
        tokens_per_second, provisional, quality_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.transaction(() => {
      this.db.prepare('DELETE FROM requests').run();
      for (const [requestId, events] of grouped) {
        const itemIds = new Set(events.map(({ event_id }) => event_id));
        const timestamps = events
          .map(({ timestamp_ms }) => timestamp_ms)
          .filter((value): value is number => value != null && Number.isFinite(value));
        const roots = events.filter(({ parent_id }) => parent_id == null || !itemIds.has(parent_id));
        const starts = roots
          .map(({ parent_timestamp_ms }) => parent_timestamp_ms)
          .filter((value): value is number => value != null && Number.isFinite(value));
        const startedAt = starts.length > 0 ? Math.min(...starts) : null;
        const finishedAt = timestamps.length > 0 ? Math.max(...timestamps) : null;
        const durationMs = startedAt == null || finishedAt == null ? null : finishedAt - startedAt;
        const outputTokens = Math.max(...events.map(({ output_tokens }) => output_tokens), 0);
        const inputTokens = Math.max(...events.map(({ input_tokens }) => input_tokens), 0);
        const cacheReadTokens = Math.max(...events.map(({ cache_read_tokens }) => cache_read_tokens), 0);
        const cacheCreationTokens = Math.max(
          ...events.map(({ cache_creation_tokens }) => cache_creation_tokens),
          0
        );
        const family = normalizeModelFamily(events.find(({ model }) => model)?.model);
        let qualityReason: string | null = null;
        if (events.some(({ synthetic }) => synthetic !== 0)) qualityReason = 'synthetic';
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
          outputSizeStratum(outputTokens),
          tokensPerSecond,
          provisional ? 1 : 0,
          qualityReason
        );
      }
      this.archiveStableInternal(nowMs);
    })();
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
      stratum: number;
      tokens_per_second: number | null;
      provisional: number;
      quality_reason: string | null;
    };
    return (this.db.prepare(`
      SELECT request_id, session_id, started_at, finished_at, duration_ms, output_tokens,
        input_tokens, cache_read_tokens, cache_creation_tokens, family, stratum,
        tokens_per_second, provisional, quality_reason
      FROM requests
      UNION ALL
      SELECT history.request_id, history.session_id, history.started_at, history.finished_at,
        history.duration_ms, history.output_tokens, history.input_tokens,
        history.cache_read_tokens, history.cache_creation_tokens, history.family,
        history.stratum, history.tokens_per_second, history.provisional, history.quality_reason
      FROM request_history history
      WHERE NOT EXISTS (SELECT 1 FROM requests live WHERE live.request_id = history.request_id)
      ORDER BY finished_at
    `).all() as Row[]).map((row) => ({
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
      stratum: row.stratum,
      tokensPerSecond: row.tokens_per_second,
      provisional: row.provisional !== 0,
      qualityReason: row.quality_reason
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
    return (
      this.db
        .prepare(`
          SELECT event_id, request_id, session_id, timestamp_ms, refusal_outcome
          FROM events WHERE refusal_outcome IS NOT NULL AND timestamp_ms IS NOT NULL
          UNION ALL
          SELECT history.event_id, history.request_id, history.session_id,
            history.timestamp_ms, history.refusal_outcome
          FROM refusal_history history
          WHERE NOT EXISTS (SELECT 1 FROM events live WHERE live.event_id = history.event_id)
          ORDER BY timestamp_ms
        `)
        .all() as Row[]
    ).map((row) => ({
      eventId: row.event_id,
      requestId: row.request_id,
      sessionId: row.session_id,
      timestampMs: row.timestamp_ms,
      outcome: row.refusal_outcome
    }));
  }

  getDataQuality(): DataQualitySummary {
    const files = this.db
      .prepare('SELECT COUNT(*) files, COALESCE(SUM(rows_read), 0) rows, COALESCE(SUM(invalid_rows), 0) invalid FROM files')
      .get() as { files: number; rows: number; invalid: number };
    const events = this.db
      .prepare(`
        SELECT COUNT(*) events,
          COALESCE(SUM(CASE WHEN quality_flags = 'uuid_missing' THEN 1 ELSE 0 END), 0) uuid_missing
        FROM events
      `)
      .get() as { events: number; uuid_missing: number };
    const occurrences = this.db.prepare('SELECT COUNT(*) count FROM occurrences').get() as { count: number };
    const requests = this.db
      .prepare(`
        WITH effective AS (
          SELECT request_id, quality_reason, provisional FROM requests
          UNION ALL
          SELECT history.request_id, history.quality_reason, history.provisional
          FROM request_history history
          WHERE NOT EXISTS (SELECT 1 FROM requests live WHERE live.request_id = history.request_id)
        )
        SELECT quality_reason, provisional, COUNT(*) count
        FROM effective GROUP BY quality_reason, provisional
      `)
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
    const archivedRequests = (this.db.prepare('SELECT COUNT(*) count FROM request_history').get() as { count: number }).count;
    const archivedRefusals = (this.db.prepare('SELECT COUNT(*) count FROM refusal_history').get() as { count: number }).count;
    return {
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
      exclusions
    };
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
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO quota_samples(window, observed_at, used_percentage, resets_at) VALUES (?, ?, ?, ?)'
    );
    this.db.transaction(() => {
      for (const [window, value] of [
        ['five_hour', sample.fiveHour],
        ['seven_day', sample.sevenDay]
      ] as const) {
        if (!value) continue;
        const resetsAt = toMillis(value.resetsAt);
        if (!Number.isFinite(resetsAt) || !Number.isFinite(value.usedPercentage)) continue;
        insert.run(window, observedAt, Math.max(0, Math.min(100, value.usedPercentage)), resetsAt);
      }
      // Retain enough history for reset-boundary diagnostics without unbounded growth.
      this.db.prepare('DELETE FROM quota_samples WHERE observed_at < ?').run(observedAt - 90 * 86_400_000);
    })();
  }

  getQuota(now: Date = new Date()): QuotaResponse {
    type Row = { window: 'five_hour' | 'seven_day'; observed_at: number; used_percentage: number; resets_at: number };
    const rows = this.db
      .prepare(`
        SELECT q.window, q.observed_at, q.used_percentage, q.resets_at
        FROM quota_samples q
        JOIN (SELECT window, MAX(observed_at) latest FROM quota_samples GROUP BY window) latest
          ON latest.window = q.window AND latest.latest = q.observed_at
      `)
      .all() as Row[];
    const map = new Map(rows.map((row) => [row.window, row]));
    const format = (row: Row | undefined) =>
      row
        ? {
            usedPercentage: row.used_percentage,
            resetsAt: new Date(row.resets_at).toISOString(),
            observedAt: new Date(row.observed_at).toISOString(),
            stale: now.getTime() - row.observed_at > 15 * 60_000 || now.getTime() >= row.resets_at
          }
        : null;
    const fiveHour = format(map.get('five_hour'));
    const sevenDay = format(map.get('seven_day'));
    return {
      available: fiveHour != null || sevenDay != null,
      source: fiveHour != null || sevenDay != null ? 'statusline' : null,
      fiveHour,
      sevenDay
    };
  }
}
