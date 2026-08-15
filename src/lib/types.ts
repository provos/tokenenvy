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
