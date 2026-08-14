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
  };
  refusals: RefusalSummary;
  scan: ScanStatus;
}

export interface SeriesResponse {
  timezone: string;
  days: number;
  points: DailyPoint[];
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
