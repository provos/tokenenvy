import { createHash } from 'node:crypto';
import { open, opendir, lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ScanStatus } from '../types';
import { parseTranscriptEvent } from '../core/parser';
import { Database, type FileCheckpoint, type ScannedEvent } from './database';

export interface ScannerOptions {
  roots: string[];
  database: Database;
  idleMs?: number;
  chunkSize?: number;
  reconciliationMs?: number;
  watchDebounceMs?: number;
  progressIntervalBytes?: number;
}

type StatusListener = (status: ScanStatus) => void;
type WatchAction = 'scan' | 'remove';

function isWithin(root: string, candidate: string): boolean {
  const within = relative(root, candidate);
  return within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within);
}

export function normalizeRoots(configured: readonly string[]): string[] {
  const result: string[] = [];
  for (const candidate of configured.map((root) => resolve(root))) {
    if (result.some((root) => isWithin(root, candidate))) continue;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (isWithin(candidate, result[index])) result.splice(index, 1);
    }
    result.push(candidate);
  }
  return result;
}

function filesystemErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = String(error.code);
  return ['EACCES', 'EMFILE', 'ENOENT', 'ENOSPC', 'EPERM', 'EIO'].includes(code) ? code : null;
}

export class Scanner {
  readonly roots: string[];
  readonly database: Database;
  readonly idleMs: number;
  readonly chunkSize: number;
  readonly reconciliationMs: number;
  readonly watchDebounceMs: number;
  readonly progressIntervalBytes: number;
  #watcher: FSWatcher | null = null;
  #listeners = new Set<StatusListener>();
  #queue: Promise<void> = Promise.resolve();
  #settleTimer: ReturnType<typeof setTimeout> | null = null;
  #reconciliationTimer: ReturnType<typeof setTimeout> | null = null;
  #watchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  #watchFlushQueued = false;
  #watchActions = new Map<string, WatchAction>();
  #resolveWatcherReady: (() => void) | null = null;
  #stopped = false;
  #status: ScanStatus = {
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

  constructor(options: ScannerOptions) {
    this.roots = normalizeRoots(options.roots);
    if (this.roots.length === 0) throw new TypeError('At least one monitored root is required.');
    this.database = options.database;
    this.idleMs = options.idleMs ?? 120_000;
    this.chunkSize = options.chunkSize ?? 256 * 1_024;
    this.reconciliationMs = options.reconciliationMs ?? 60_000;
    this.watchDebounceMs = options.watchDebounceMs ?? 150;
    this.progressIntervalBytes = Math.max(1, options.progressIntervalBytes ?? 4 * 1_024 * 1_024);
    this.database.syncRoots(this.roots.map((root) => this.database.rootId(root)));
  }

  getStatus(): ScanStatus {
    return { ...this.#status };
  }

  subscribe(listener: StatusListener): () => void {
    this.#listeners.add(listener);
    listener(this.getStatus());
    return () => this.#listeners.delete(listener);
  }

  private publish(patch: Partial<ScanStatus>): void {
    this.#status = { ...this.#status, ...patch, updatedAt: new Date().toISOString() };
    this.database.setScanStatus(this.#status);
    for (const listener of this.#listeners) listener(this.getStatus());
  }

  private rootFor(filePath: string): string | null {
    const absolute = resolve(filePath);
    if (!absolute.endsWith('.jsonl')) return null;
    return this.roots.find((root) => isWithin(root, absolute)) ?? null;
  }

  private accepts(filePath: string): boolean {
    return this.rootFor(filePath) != null;
  }

  private async discover(directory: string, result: string[] = []): Promise<string[]> {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const item = resolve(directory, entry.name);
      if (entry.isDirectory()) await this.discover(item, result);
      else if (entry.isFile() && item.endsWith('.jsonl')) result.push(item);
    }
    return result;
  }

  async scanAll(rebuildWhenUnchanged = true): Promise<ScanStatus> {
    return this.scanAllInternal(rebuildWhenUnchanged);
  }

  private async scanAllInternal(rebuildWhenUnchanged: boolean): Promise<ScanStatus> {
    this.publish({
      state: 'discovering',
      filesDiscovered: 0,
      filesScanned: 0,
      bytesRead: 0,
      rowsRead: 0,
      invalidRows: 0,
      lastError: null,
    });
    try {
      let replacementSnapshotTaken = false;
      let replacementSnapshotChanged = false;
      const archiveBeforeFirstReplacement = () => {
        if (replacementSnapshotTaken) return;
        replacementSnapshotTaken = true;
        replacementSnapshotChanged = this.database.archiveStable(Date.now());
      };
      const activeRootIds = new Set(this.roots.map((root) => this.database.rootId(root)));
      const sourceRecords = this.database.listSources();
      const successfulRootIds = new Set<string>();
      const openedRootIds = new Set<string>();
      const present = new Set<string>();
      const failures: string[] = [];
      let changed = false;
      let discovered = 0;
      for (const root of this.roots) {
        const rootId = this.database.rootId(root);
        let files: string[];
        try {
          files = (await this.discover(root)).sort();
        } catch (error) {
          const code = filesystemErrorCode(error) ?? 'IO';
          const hasIndexedSources = sourceRecords.some(
            (source) => source.rootId === rootId || source.rootId === '',
          );
          if (code === 'ENOENT' && !hasIndexedSources) {
            successfulRootIds.add(rootId);
            continue;
          }
          failures.push(code);
          continue;
        }
        discovered += files.length;
        this.publish({ state: 'scanning', filesDiscovered: discovered });
        try {
          for (const file of files) {
            present.add(this.database.sourceId(file));
            changed =
              (await this.scanFileInternal(file, false, root, archiveBeforeFirstReplacement)) ||
              changed;
          }
          successfulRootIds.add(rootId);
          openedRootIds.add(rootId);
        } catch (error) {
          const code = filesystemErrorCode(error);
          if (!code) throw error;
          failures.push(code);
        }
      }
      const allRootsOpened = openedRootIds.size === this.roots.length;
      const missingSources = this.database.listSources().flatMap(({ sourceId, rootId }) => {
        if (!activeRootIds.has(rootId) && rootId !== '') return [sourceId];
        if (rootId === '') return allRootsOpened && !present.has(sourceId) ? [sourceId] : [];
        return successfulRootIds.has(rootId) && !present.has(sourceId) ? [sourceId] : [];
      });
      const retracted = this.database.retractSources(missingSources);
      const databaseChanged = changed || retracted;
      let analyticsChanged = replacementSnapshotChanged;
      if (databaseChanged || rebuildWhenUnchanged) {
        // One rebuild after discovery is dramatically faster than rebuilding after
        // each historical file and makes clean/chunked ingestion converge.
        this.database.rebuildRequests(Date.now(), this.idleMs);
        analyticsChanged = true;
      } else {
        analyticsChanged = this.database.archiveStable(Date.now());
      }
      const state = failures.length > 0 ? 'error' : 'idle';
      const lastError =
        failures.length > 0
          ? `Unable to scan ${failures.length} monitored root${failures.length === 1 ? '' : 's'} (${[...new Set(failures)].join(', ')})`
          : null;
      this.publish({
        state,
        lastError,
        ...(analyticsChanged ? { revision: this.#status.revision + 1 } : {}),
      });
      if (databaseChanged) this.scheduleSettledRebuild();
      return this.getStatus();
    } catch (error) {
      this.publish({
        state: 'error',
        lastError: filesystemErrorCode(error) ?? 'Scanner database failure',
      });
      throw error;
    }
  }

  async scanFile(filePath: string): Promise<void> {
    await this.scanFileInternal(filePath, true);
  }

  private async scanFileInternal(
    filePath: string,
    rebuild: boolean,
    knownRoot?: string,
    beforeReplace?: () => void,
  ): Promise<boolean> {
    const root = knownRoot ?? this.rootFor(filePath);
    if (!root) return false;
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    const sourceId = this.database.sourceId(resolve(filePath));
    const previous = this.database.getFileCheckpoint(sourceId);
    const rootId = this.database.rootId(root);
    const identity = `${metadata.dev}:${metadata.ino}`;
    let replace =
      previous != null &&
      (previous.identity !== identity ||
        metadata.size < previous.size ||
        (metadata.size === previous.size && metadata.mtimeMs !== previous.mtimeMs));

    if (previous && previous.rootId !== rootId) this.database.assignSourceRoot(sourceId, rootId);
    if (previous && metadata.size === previous.size && metadata.mtimeMs === previous.mtimeMs)
      return false;

    if (!replace && previous && previous.offset > 0) {
      const actualTail = await this.hashTail(filePath, previous.offset);
      if (actualTail !== previous.tailHash) replace = true;
    }
    const startOffset = replace ? 0 : (previous?.offset ?? 0);
    const progressBase = {
      bytesRead: this.#status.bytesRead,
      rowsRead: this.#status.rowsRead,
      invalidRows: this.#status.invalidRows,
    };
    const result = await this.readCompleteLines(filePath, sourceId, startOffset, (progress) => {
      this.publish({
        bytesRead: progressBase.bytesRead + progress.bytesRead,
        rowsRead: progressBase.rowsRead + progress.rows,
        invalidRows: progressBase.invalidRows + progress.invalidRows,
      });
    });
    const rowsRead = (replace ? 0 : (previous?.rowsRead ?? 0)) + result.rows;
    const invalidRows = (replace ? 0 : (previous?.invalidRows ?? 0)) + result.invalidRows;
    const checkpoint: FileCheckpoint = {
      sourceId,
      rootId,
      identity,
      size: metadata.size,
      offset: result.completeOffset,
      mtimeMs: metadata.mtimeMs,
      tailHash: await this.hashTail(filePath, result.completeOffset),
      rowsRead,
      invalidRows,
    };
    if (replace) beforeReplace?.();
    this.database.applyFileScan({
      checkpoint,
      events: result.events,
      replace,
      archiveBeforeReplace: beforeReplace == null,
    });
    this.publish({
      filesScanned: this.#status.filesScanned + 1,
      bytesRead: progressBase.bytesRead + result.bytesRead,
      rowsRead: progressBase.rowsRead + result.rows,
      invalidRows: progressBase.invalidRows + result.invalidRows,
    });
    if (rebuild) {
      this.database.rebuildRequests(Date.now(), this.idleMs);
      this.publish({ state: 'idle', revision: this.#status.revision + 1, lastError: null });
      this.scheduleSettledRebuild();
    }
    return true;
  }

  private async readCompleteLines(
    filePath: string,
    sourceId: string,
    startOffset: number,
    onProgress?: (progress: { bytesRead: number; rows: number; invalidRows: number }) => void,
  ): Promise<{
    events: ScannedEvent[];
    rows: number;
    invalidRows: number;
    bytesRead: number;
    completeOffset: number;
  }> {
    const handle = await open(filePath, 'r');
    const events: ScannedEvent[] = [];
    let lineParts: Buffer[] = [];
    let lineLength = 0;
    let position = startOffset;
    let completeOffset = startOffset;
    let rows = 0;
    let invalidRows = 0;
    let bytesRead = 0;
    let nextProgressAt = this.progressIntervalBytes;
    let lastProgressAt = Date.now();
    try {
      while (true) {
        const chunk = Buffer.allocUnsafe(this.chunkSize);
        const read = await handle.read(chunk, 0, chunk.length, position);
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
        position += read.bytesRead;
        const data = chunk.subarray(0, read.bytesRead);
        let segmentStart = 0;
        let newline = data.indexOf(0x0a, segmentStart);
        while (newline !== -1) {
          const segment = data.subarray(segmentStart, newline);
          const rawLength = lineLength + segment.length;
          let rawBuffer: Buffer;
          if (lineParts.length === 0) {
            rawBuffer = segment;
          } else {
            if (segment.length > 0) lineParts.push(segment);
            rawBuffer = Buffer.concat(lineParts, rawLength);
          }
          const lineOffset = completeOffset;
          completeOffset += rawLength + 1;
          lineParts = [];
          lineLength = 0;
          rows += 1;
          const line =
            rawBuffer.length > 0 && rawBuffer[rawBuffer.length - 1] === 0x0d
              ? rawBuffer.subarray(0, -1).toString('utf8')
              : rawBuffer.toString('utf8');
          if (!line) continue;
          const event = parseTranscriptEvent(line, sourceId, lineOffset, (value) =>
            this.database.digest(value),
          );
          if (event) events.push({ lineOffset, event });
          else invalidRows += 1;
          segmentStart = newline + 1;
          newline = data.indexOf(0x0a, segmentStart);
        }
        const remainder = data.subarray(segmentStart);
        if (remainder.length > 0) {
          lineParts.push(remainder);
          lineLength += remainder.length;
        }
        const now = Date.now();
        if (bytesRead >= nextProgressAt || now - lastProgressAt >= 250) {
          onProgress?.({ bytesRead, rows, invalidRows });
          nextProgressAt = bytesRead + this.progressIntervalBytes;
          lastProgressAt = now;
        }
      }
    } finally {
      await handle.close();
    }
    return { events, rows, invalidRows, bytesRead, completeOffset };
  }

  private async hashTail(filePath: string, offset: number): Promise<string> {
    if (offset <= 0) return createHash('sha256').update('').digest('hex');
    const length = Math.min(128, offset);
    const buffer = Buffer.allocUnsafe(length);
    const handle = await open(filePath, 'r');
    try {
      const result = await handle.read(buffer, 0, length, offset - length);
      return createHash('sha256').update(buffer.subarray(0, result.bytesRead)).digest('hex');
    } finally {
      await handle.close();
    }
  }

  async removeFile(filePath: string): Promise<void> {
    if (!this.accepts(filePath)) return;
    if (this.database.retractSource(this.database.sourceId(resolve(filePath)))) {
      this.database.rebuildRequests(Date.now(), this.idleMs);
      this.publish({ state: 'idle', revision: this.#status.revision + 1, lastError: null });
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const result = this.#queue.then(task);
    this.#queue = result.catch((error: unknown) => {
      this.publish({
        state: 'error',
        lastError: filesystemErrorCode(error) ?? 'Scanner task failure',
      });
    });
    return result;
  }

  private scheduleSettledRebuild(): void {
    if (this.#stopped) return;
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => {
      this.#settleTimer = null;
      void this.enqueue(async () => {
        if (this.#stopped) return;
        this.database.rebuildRequests(Date.now(), this.idleMs);
        this.publish({ state: 'idle', revision: this.#status.revision + 1 });
      }).catch(() => {});
    }, this.idleMs + 50);
    this.#settleTimer.unref?.();
  }

  private scheduleReconciliation(): void {
    if (this.#stopped || this.reconciliationMs <= 0 || this.#reconciliationTimer) return;
    this.#reconciliationTimer = setTimeout(() => {
      this.#reconciliationTimer = null;
      const reconciliation = this.enqueue(async () => {
        if (this.#stopped) return;
        await this.scanAll(false);
      });
      void reconciliation.catch(() => {}).finally(() => this.scheduleReconciliation());
    }, this.reconciliationMs);
    this.#reconciliationTimer.unref?.();
  }

  private queueWatchAction(filePath: string, action: WatchAction): void {
    if (this.#stopped || !this.accepts(filePath)) return;
    this.#watchActions.set(resolve(filePath), action);
    this.scheduleWatchFlush();
  }

  private scheduleWatchFlush(): void {
    if (this.#stopped || this.#watchFlushTimer || this.#watchFlushQueued) return;
    this.#watchFlushTimer = setTimeout(() => {
      this.#watchFlushTimer = null;
      if (this.#stopped) return;
      this.#watchFlushQueued = true;
      void this.enqueue(async () => {
        try {
          await this.flushWatchActions();
        } finally {
          this.#watchFlushQueued = false;
          if (this.#watchActions.size > 0) this.scheduleWatchFlush();
        }
      }).catch(() => {});
    }, this.watchDebounceMs);
    this.#watchFlushTimer.unref?.();
  }

  private async flushWatchActions(): Promise<void> {
    if (this.#stopped) {
      this.#watchActions.clear();
      return;
    }
    const actions = [...this.#watchActions.entries()];
    this.#watchActions.clear();
    const removedFiles: string[] = [];
    const unavailableRoots = new Set<string>();
    let changed = false;

    for (const [filePath, action] of actions) {
      if (action === 'remove') {
        removedFiles.push(filePath);
        continue;
      }
      try {
        changed = (await this.scanFileInternal(filePath, false)) || changed;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          removedFiles.push(filePath);
        } else {
          throw error;
        }
      }
    }

    const removedSources = new Set<string>();
    const rootAvailability = new Map<string, boolean>();
    for (const filePath of removedFiles) {
      const root = this.rootFor(filePath);
      if (!root) continue;
      let available = rootAvailability.get(root);
      if (available === undefined) {
        try {
          const metadata = await lstat(root);
          available = metadata.isDirectory() && !metadata.isSymbolicLink();
        } catch {
          available = false;
        }
        rootAvailability.set(root, available);
      }
      if (available) removedSources.add(this.database.sourceId(filePath));
      else unavailableRoots.add(root);
    }

    changed = this.database.retractSources([...removedSources]) || changed;
    if (!changed || this.#stopped) {
      if (unavailableRoots.size > 0 && !this.#stopped) {
        this.publish({
          state: 'error',
          lastError: `Unable to scan ${unavailableRoots.size} monitored root${unavailableRoots.size === 1 ? '' : 's'} (ENOENT)`,
        });
      }
      return;
    }
    this.database.rebuildRequests(Date.now(), this.idleMs);
    this.publish({
      state: unavailableRoots.size > 0 ? 'error' : 'idle',
      revision: this.#status.revision + 1,
      lastError:
        unavailableRoots.size > 0
          ? `Unable to scan ${unavailableRoots.size} monitored root${unavailableRoots.size === 1 ? '' : 's'} (ENOENT)`
          : null,
    });
    this.scheduleSettledRebuild();
  }

  async start(): Promise<void> {
    if (this.#watcher || this.#stopped) return;
    this.#watcher = chokidar.watch(this.roots, {
      ignored: (candidate, stats) => Boolean(stats?.isFile() && !candidate.endsWith('.jsonl')),
      ignoreInitial: true,
      followSymlinks: false,
      persistent: true,
    });
    this.#watcher.on('add', (file) => this.queueWatchAction(file, 'scan'));
    this.#watcher.on('change', (file) => this.queueWatchAction(file, 'scan'));
    this.#watcher.on('unlink', (file) => this.queueWatchAction(file, 'remove'));
    this.#watcher.on('error', (error) => {
      const code = filesystemErrorCode(error) ?? 'IO';
      // A configured root may not exist yet. Reconciliation distinguishes an
      // empty never-seen root from a previously indexed unavailable root.
      if (code === 'ENOENT') return;
      this.publish({ state: 'error', lastError: `Filesystem watcher failure (${code})` });
    });
    await new Promise<void>((resolveReady) => {
      this.#resolveWatcherReady = resolveReady;
      this.#watcher?.once('ready', () => {
        this.#resolveWatcherReady = null;
        resolveReady();
      });
    });
    if (this.#stopped) return;
    this.scheduleReconciliation();
    // Establish the watcher first, then serialize discovery behind any events
    // it observed. This closes the startup window where appends could be lost.
    await this.enqueue(async () => {
      await this.scanAll();
    });
    if (this.#stopped) return;
    // OS watcher delivery is not itself a durable queue. A cheap unchanged
    // discovery pass catches files created in the last slice of the initial
    // scan even if the platform coalesces or loses the corresponding event.
    await this.enqueue(async () => {
      await this.scanAllInternal(false);
    });
    if (this.#stopped) return;
    // Give filesystem notifications generated during the final slice of the
    // initial scan one debounce window to arrive, then drain them before start
    // resolves. Periodic reconciliation remains the fallback for lossy OS
    // watchers, but this closes the common ready/scan handoff race immediately.
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, this.watchDebounceMs);
    });
    if (this.#stopped) return;
    if (this.#watchFlushTimer) clearTimeout(this.#watchFlushTimer);
    this.#watchFlushTimer = null;
    await this.enqueue(async () => this.flushWatchActions());
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#resolveWatcherReady?.();
    this.#resolveWatcherReady = null;
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    this.#settleTimer = null;
    if (this.#reconciliationTimer) clearTimeout(this.#reconciliationTimer);
    this.#reconciliationTimer = null;
    if (this.#watchFlushTimer) clearTimeout(this.#watchFlushTimer);
    this.#watchFlushTimer = null;
    this.#watchActions.clear();
    await this.#watcher?.close();
    this.#watcher = null;
    await this.#queue;
    // Tasks already running when stop began may have attempted to arm timers.
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    this.#settleTimer = null;
    if (this.#reconciliationTimer) clearTimeout(this.#reconciliationTimer);
    this.#reconciliationTimer = null;
    if (this.#watchFlushTimer) clearTimeout(this.#watchFlushTimer);
    this.#watchFlushTimer = null;
  }
}
