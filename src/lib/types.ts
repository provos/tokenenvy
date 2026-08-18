export const MODEL_FAMILIES = ['opus', 'sonnet', 'fable', 'haiku', 'other'] as const;

export type ModelFamily = (typeof MODEL_FAMILIES)[number];

export interface QuantileSummary {
  count: number;
  sessions: number;
  median: number;
  q1: number;
  q3: number;
  p10: number;
  p90: number;
  ciLow: number | null;
  ciHigh: number | null;
}

export interface DailyPoint extends QuantileSummary {
  date: string;
  family: ModelFamily;
  outputTokens: number;
  provisional: number;
}

export interface ModelSummary extends QuantileSummary {
  family: ModelFamily;
  outputTokens: number;
  share: number;
}

export interface SpeedIndex {
  value: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  percentile: number | null;
  eligible: boolean;
  reason: string | null;
}

export interface OverviewResponse {
  generatedAt: string;
  timezone: string;
  today: string;
  headline: QuantileSummary & { outputTokens: number; provisional: number };
  speedIndex: SpeedIndex;
  models: ModelSummary[];
  weekly: {
    outputTokens: number;
    projectedOutputTokens: number | null;
    elapsedFraction: number;
    previousFourWeekMedian: number | null;
    recap: WeeklyRecap;
  };
  refusals: RefusalSummary;
  failures: FailureSummary;
  scan: ScanStatus;
}

export interface WeeklyRecap {
  weekStart: string;
  throughDate: string;
  daysObserved: number;
  observedDates: string[];
  requestCount: number;
  sessions: number;
  median: number | null;
  speedIndex: SpeedIndex;
  models: WeeklyModelMix[];
  fastestDay: { date: string; median: number } | null;
  slowestDay: { date: string; median: number } | null;
  refusals: PeriodRefusalSummary;
  failures: PeriodFailureSummary;
}

export interface WeeklyModelMix {
  family: ModelFamily;
  requestCount: number;
  outputTokens: number;
  share: number;
}

export interface SeriesResponse {
  timezone: string;
  days: number;
  points: DailyPoint[];
  refusals: RefusalTimeline;
  failures: FailureTimeline;
}

export interface RefusalCounts {
  attempted: number;
  recovered: number;
  userVisible: number;
  unknown: number;
}

export interface DatedRefusalCounts extends RefusalCounts {
  date: string;
}

export interface PeriodRefusalSummary extends RefusalCounts {
  recorded: boolean;
  affectedDates: DatedRefusalCounts[];
}

export interface RefusalFamilyCounts extends RefusalCounts {
  family: ModelFamily;
}

export interface RefusalTimelineDay {
  date: string;
  families: RefusalFamilyCounts[];
  unattributed: RefusalCounts;
}

export interface RefusalTimeline {
  recorded: boolean;
  days: RefusalTimelineDay[];
}

/**
 * Transport-layer failures reported by the CLI as `isApiErrorMessage` rows.
 * `overloaded` and `server_error` are platform faults ("could not"); they are
 * counted separately from classifier refusals ("would not"). `safeguard_block`
 * is an API-layer refusal folded into RefusalCounts, and `client` covers a
 * missing login or any measured non-5xx status, which say nothing about service
 * quality. `server_error` therefore holds 5xx and status-less rows only.
 */
export type FailureClass = 'overloaded' | 'server_error' | 'safeguard_block' | 'client';

/**
 * Failure events carry `model: "<synthetic>"`, so they can never be attributed
 * to a model family. They are reported unattributed and stay visible under
 * every family filter.
 */
export interface FailureCounts {
  attempted: number;
  overloaded: number;
  serverError: number;
}

export interface DatedFailureCounts extends FailureCounts {
  date: string;
}

export interface FailureSummary extends FailureCounts {
  recorded: boolean;
  perThousand: number | null;
  byDay: DatedFailureCounts[];
}

export interface FailureTimeline {
  recorded: boolean;
  days: DatedFailureCounts[];
}

export interface PeriodFailureSummary extends FailureCounts {
  recorded: boolean;
  affectedDates: DatedFailureCounts[];
}

export interface LongitudinalRefusalDay {
  date: string;
  selected: RefusalCounts;
  unattributed: RefusalCounts;
}

export interface LongitudinalPoint {
  date: string;
  index: number;
  requestCount: number;
  coverage: number;
}

export interface LongitudinalSummary {
  timezone: string;
  days: 28 | 90 | 365;
  startDate: string;
  throughDate: string;
  families: ModelFamily[];
  observedDays: number;
  measuredRequests: number;
  measuredOutputTokens: number;
  qualifiedDays: number;
  comparableRequestCoverage: number;
  quality: 'robust' | 'directional' | 'insufficient';
  variationPct: number | null;
  trendPct: number | null;
  points: LongitudinalPoint[];
  refusalsRecorded: boolean;
  refusals: LongitudinalRefusalDay[];
  failuresRecorded: boolean;
  failures: DatedFailureCounts[];
}

export interface HistogramBin {
  lower: number;
  upper: number;
  count: number;
  family?: ModelFamily;
}

export interface DayDetailResponse {
  date: string;
  timezone: string;
  summary: QuantileSummary & { outputTokens: number };
  speedIndex: SpeedIndex;
  models: ModelSummary[];
  histogram: HistogramBin[];
  hourly: Array<{ hour: number; median: number | null; count: number }>;
  exclusions: Record<string, number>;
}

export interface RefusalSummary {
  recorded: boolean;
  attempted: number;
  recovered: number;
  userVisible: number;
  unknown: number;
  perThousand: number | null;
  byDay: Array<{ date: string; attempted: number; recovered: number; userVisible: number }>;
}

export interface QuotaWindow {
  usedPercentage: number;
  resetsAt: string;
  observedAt: string;
  stale: boolean;
}

export interface QuotaResponse {
  available: boolean;
  source: 'statusline' | null;
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
}

export interface ScanStatus {
  state: 'idle' | 'discovering' | 'scanning' | 'error';
  filesDiscovered: number;
  filesScanned: number;
  bytesRead: number;
  rowsRead: number;
  invalidRows: number;
  updatedAt: string | null;
  lastError: string | null;
  revision: number;
}
