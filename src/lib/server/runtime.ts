import { Analytics } from '$lib/core/analytics';
import { Database } from '$lib/server/database';
import { normalizeRoots, Scanner } from '$lib/server/scanner';
import type {
  DayDetailResponse,
  OverviewResponse,
  QuotaResponse,
  RefusalSummary,
  ScanStatus,
  SeriesResponse,
} from '$lib/types';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface RuntimeOptions {
  logsRoots?: string[];
  dataDirectory?: string;
  timezone?: string;
  rescan?: boolean;
}

type StatusListener = (status: ScanStatus) => void;

function defaultDataDirectory(): string {
  const configured = process.env.TOKENENVY_DATA_DIR;
  return configured ? resolve(expandHome(configured)) : join(homedir(), '.tokenenvy');
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

export function normalizeLogRoots(values: string[]): string[] {
  return normalizeRoots(values.map(expandHome));
}

function configuredLogRoots(): string[] {
  const encoded = process.env.TOKENENVY_LOGS;
  if (!encoded) return [join(homedir(), '.claude', 'projects')];

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error('TOKENENVY_LOGS must be a JSON array of paths.');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((value) => typeof value !== 'string' || !value)
  ) {
    throw new Error('TOKENENVY_LOGS must be a non-empty JSON array of paths.');
  }
  return normalizeLogRoots(parsed as string[]);
}

export function validTimezone(candidate: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format();
    return true;
  } catch {
    return false;
  }
}

function configuredTimezone(): string {
  const candidate = process.env.TOKENENVY_TIMEZONE;
  if (candidate && validTimezone(candidate)) return candidate;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export class DashboardRuntime {
  readonly timezone: string;
  readonly logsRoots: string[];
  readonly dataDirectory: string;

  private readonly database: Database;
  private readonly scanner: Scanner;
  private readonly analytics: Analytics;
  private readonly listeners = new Set<StatusListener>();
  private unsubscribeScanner: (() => void) | null = null;
  private scanTask: Promise<void> | null = null;
  private closed = false;

  constructor(options: RuntimeOptions = {}) {
    this.logsRoots = normalizeLogRoots(options.logsRoots ?? configuredLogRoots());
    if (this.logsRoots.length === 0) throw new Error('At least one transcript root is required.');
    this.dataDirectory = resolve(options.dataDirectory ?? defaultDataDirectory());
    this.timezone =
      options.timezone && validTimezone(options.timezone) ? options.timezone : configuredTimezone();

    mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
    const dbPath = join(this.dataDirectory, 'index.sqlite3');
    const rescan = options.rescan ?? process.env.TOKENENVY_RESCAN === '1';

    this.database = new Database({ path: dbPath });
    if (rescan) this.database.resetLive();
    this.scanner = new Scanner({ roots: this.logsRoots, database: this.database });
    this.analytics = new Analytics(this.database);
    this.unsubscribeScanner = this.scanner.subscribe((status) => {
      for (const listener of this.listeners) listener(status);
    });
  }

  start(): void {
    if (this.scanTask || this.closed) return;
    // Scanning stays in the background so the shell and progress UI are responsive.
    this.scanTask = (async () => {
      try {
        await this.scanner.start();
      } catch {
        // Scanner owns and publishes its error status; API requests remain available.
      }
    })();
  }

  status(): ScanStatus {
    return this.scanner.getStatus();
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  overview(): OverviewResponse {
    return this.analytics.overview(this.timezone);
  }

  series(days: number): SeriesResponse {
    return this.analytics.series(days, this.timezone);
  }

  day(date: string): DayDetailResponse | null {
    return this.analytics.day(date, this.timezone);
  }

  refusals(): RefusalSummary {
    return this.analytics.refusals(this.timezone);
  }

  quota(): QuotaResponse {
    return this.analytics.quota();
  }

  dataQuality(): ReturnType<Analytics['dataQuality']> {
    return this.analytics.dataQuality();
  }

  recordQuotaSample(sample: {
    fiveHour?: { usedPercentage: number; resetsAt: string };
    sevenDay?: { usedPercentage: number; resetsAt: string };
    observedAt?: string;
  }): void {
    this.database.recordQuotaSample(sample);
    // Quota changes are meaningful dashboard revisions even without a transcript append.
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeScanner?.();
    this.unsubscribeScanner = null;
    await this.scanner.stop();
    await this.scanTask;
    this.database.close();
    this.listeners.clear();
  }
}

let singleton: DashboardRuntime | null = null;

export function getRuntime(): DashboardRuntime {
  if (!singleton) {
    singleton = new DashboardRuntime();
    singleton.start();
  }
  return singleton;
}

export async function closeRuntime(): Promise<void> {
  if (!singleton) return;
  const current = singleton;
  singleton = null;
  await current.close();
}

export function resetRuntimeForTests(): Promise<void> {
  return closeRuntime();
}

// adapter-node emits this after it stops accepting requests. Closing the
// persistent watcher lets SIGINT/SIGTERM complete without abandoning DB work.
process.once('sveltekit:shutdown', () => {
  void closeRuntime();
});
