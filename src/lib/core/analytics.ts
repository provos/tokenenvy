import type {
  DailyPoint,
  DatedFailureCounts,
  DayDetailResponse,
  FailureCounts,
  FailureSummary,
  FailureTimeline,
  HistogramBin,
  LongitudinalSummary,
  ModelFamily,
  ModelSummary,
  OverviewResponse,
  PeriodRefusalSummary,
  QuotaResponse,
  RefusalCounts,
  RefusalSummary,
  RefusalTimeline,
  SeriesResponse,
  SpeedIndex,
} from '../types';
import { MODEL_FAMILIES } from '../types';
import {
  Database,
  type DataQualitySummary,
  type StoredFailure,
  type StoredRequest,
} from '../server/database';
import { quantile, summarize, type MetricSample } from './statistics';
import {
  addCalendarDays,
  daysBetween,
  isoWeekday,
  localDate,
  validateTimezone,
  zonedMidnight,
  zonedParts,
} from './time';

interface DatedRequest extends StoredRequest {
  date: string;
}

interface DatedSnapshot {
  includingProvisional: DatedRequest[];
  completed: DatedRequest[];
}

function metrics(requests: readonly StoredRequest[]): MetricSample[] {
  return requests
    .filter(
      (request) => request.tokensPerSecond != null && Number.isFinite(request.tokensPerSecond),
    )
    .map((request) => ({ value: request.tokensPerSecond as number, sessionId: request.sessionId }));
}

function modelSummaries(requests: readonly StoredRequest[]): ModelSummary[] {
  const byFamily = new Map<ModelFamily, StoredRequest[]>();
  let totalOutput = 0;
  for (const request of requests) {
    totalOutput += request.outputTokens;
    const group = byFamily.get(request.family) ?? [];
    group.push(request);
    byFamily.set(request.family, group);
  }
  return MODEL_FAMILIES.flatMap((family) => {
    const selected = byFamily.get(family) ?? [];
    if (selected.length === 0) return [];
    const outputTokens = selected.reduce((total, request) => total + request.outputTokens, 0);
    return [
      {
        family,
        ...summarize(metrics(selected)),
        outputTokens,
        share: totalOutput > 0 ? outputTokens / totalOutput : 0,
      },
    ];
  });
}

function weeklyModelMix(
  requests: readonly StoredRequest[],
): OverviewResponse['weekly']['recap']['models'] {
  const byFamily = new Map<ModelFamily, { requestCount: number; outputTokens: number }>();
  let totalOutput = 0;
  for (const request of requests) {
    totalOutput += request.outputTokens;
    const current = byFamily.get(request.family) ?? { requestCount: 0, outputTokens: 0 };
    current.requestCount += 1;
    current.outputTokens += request.outputTokens;
    byFamily.set(request.family, current);
  }
  return MODEL_FAMILIES.flatMap((family) => {
    const summary = byFamily.get(family);
    return summary
      ? [
          {
            family,
            ...summary,
            share: totalOutput > 0 ? summary.outputTokens / totalOutput : 0,
          },
        ]
      : [];
  });
}

function median(values: readonly number[]): number | null {
  return values.length > 0 ? quantile(values, 0.5) : null;
}

function emptyRefusalCounts(): RefusalCounts {
  return { attempted: 0, recovered: 0, userVisible: 0, unknown: 0 };
}

function addRefusalOutcome(
  counts: RefusalCounts,
  outcome: 'recovered' | 'user_visible' | 'unknown',
): void {
  counts.attempted += 1;
  if (outcome === 'recovered') counts.recovered += 1;
  else if (outcome === 'user_visible') counts.userVisible += 1;
  else counts.unknown += 1;
}

function addRefusalCounts(target: RefusalCounts, source: RefusalCounts): void {
  target.attempted += source.attempted;
  target.recovered += source.recovered;
  target.userVisible += source.userVisible;
  target.unknown += source.unknown;
}

/**
 * The model family a refusal may be filed under, or `undefined` when the
 * request never named a model. A request whose only assistant rows are API
 * error rows reports `model: "<synthetic>"`, which resolves to the `other`
 * family — but `other` is never offered as a family chip, so a refusal filed
 * there would be counted and then drawn nowhere. Reporting those unattributed
 * keeps them visible under every filter, the same choice made for failures.
 */
function attributableFamily(request: StoredRequest): ModelFamily | undefined {
  if (request.family === 'other' && request.qualityReason === 'api_error') return undefined;
  return request.family;
}

function emptyFailureCounts(): FailureCounts {
  return { attempted: 0, overloaded: 0, serverError: 0 };
}

/**
 * Failure events report `model: "<synthetic>"`, so they are never attributed to
 * a model family and stay visible under every family filter.
 */
function failureDays(
  failures: readonly StoredFailure[],
  timezone: string,
  start?: string,
  end?: string,
): DatedFailureCounts[] {
  const dates = new Map<string, FailureCounts>();
  for (const failure of failures) {
    const date = localDate(failure.timestampMs, timezone);
    if ((start != null && date < start) || (end != null && date > end)) continue;
    const counts = dates.get(date) ?? emptyFailureCounts();
    counts.attempted += 1;
    if (failure.failureClass === 'overloaded') counts.overloaded += 1;
    else counts.serverError += 1;
    dates.set(date, counts);
  }
  return [...dates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, counts]) => ({ date, ...counts }));
}

function theilSen(points: readonly { x: number; y: number }[]): {
  slope: number;
  intercept: number;
} | null {
  if (points.length < 2) return null;
  const slopes: number[] = [];
  for (let left = 0; left < points.length - 1; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const elapsed = points[right].x - points[left].x;
      if (elapsed > 0) slopes.push((points[right].y - points[left].y) / elapsed);
    }
  }
  const slope = median(slopes);
  if (slope === null) return null;
  const intercept = median(points.map((point) => point.y - slope * point.x));
  return intercept === null ? null : { slope, intercept };
}

function speedIndex(
  current: readonly DatedRequest[],
  baseline: readonly DatedRequest[],
  options: { confidence?: boolean; percentile?: boolean } = {},
): SpeedIndex {
  const key = (request: StoredRequest): string => `${request.family}:${request.stratum}`;
  const baselineByStratum = new Map<string, DatedRequest[]>();
  const currentByStratum = new Map<string, DatedRequest[]>();
  for (const request of baseline) {
    const group = baselineByStratum.get(key(request)) ?? [];
    group.push(request);
    baselineByStratum.set(key(request), group);
  }
  for (const request of current) {
    const group = currentByStratum.get(key(request)) ?? [];
    group.push(request);
    currentByStratum.set(key(request), group);
  }

  const usable = [...baselineByStratum.entries()].flatMap(([stratum, requests]) => {
    if (requests.length < 5 || (currentByStratum.get(stratum)?.length ?? 0) < 2) return [];
    const baselineMedian = median(metrics(requests).map(({ value }) => value));
    return baselineMedian != null && baselineMedian > 0
      ? [{ stratum, baselineMedian, weight: requests.length }]
      : [];
  });
  const usableKeys = new Set(usable.map(({ stratum }) => stratum));
  const coveredCurrent = current.filter((request) => usableKeys.has(key(request)));
  const coveredBaseline = baseline.filter((request) => usableKeys.has(key(request)));
  const currentCoverage = current.length > 0 ? coveredCurrent.length / current.length : 0;
  const baselineCoverage = baseline.length > 0 ? coveredBaseline.length / baseline.length : 0;
  const calculate = (requests: readonly StoredRequest[]): number | null => {
    const candidateByStratum = new Map<string, StoredRequest[]>();
    for (const request of requests) {
      const group = candidateByStratum.get(key(request)) ?? [];
      group.push(request);
      candidateByStratum.set(key(request), group);
    }
    let weightedLogRatio = 0;
    let totalWeight = 0;
    for (const { stratum, baselineMedian, weight } of usable) {
      const candidates = candidateByStratum.get(stratum) ?? [];
      if (candidates.length === 0) continue;
      const candidateMedian = median(metrics(candidates).map(({ value }) => value));
      if (candidateMedian == null) continue;
      weightedLogRatio += Math.log(candidateMedian / baselineMedian) * weight;
      totalWeight += weight;
    }
    return totalWeight > 0 ? Math.exp(weightedLogRatio / totalWeight) * 100 : null;
  };

  const value = calculate(current);
  const currentSessions = new Set(coveredCurrent.map(({ sessionId }) => sessionId)).size;
  const baselineDays = new Set(baseline.map(({ date }) => date)).size;
  let reason: string | null = null;
  if (current.length < 20) reason = 'At least 20 requests are required.';
  else if (baselineDays < 7) reason = 'At least seven baseline days are required.';
  else if (baseline.length < 100) reason = 'At least 100 baseline requests are required.';
  else if (currentCoverage < 0.7 || baselineCoverage < 0.7 || value == null) {
    reason = 'Not enough comparable model and output-size coverage.';
  }

  let ciLow: number | null = null;
  let ciHigh: number | null = null;
  if (!reason && currentSessions >= 5 && options.confidence !== false) {
    const groups = new Map<string, DatedRequest[]>();
    for (const request of current) {
      const group = groups.get(request.sessionId) ?? [];
      group.push(request);
      groups.set(request.sessionId, group);
    }
    const sessions = [...groups.values()];
    let state = 0x51eed;
    const random = () => {
      state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
      state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
      state ^= state >>> 16;
      return (state >>> 0) / 4_294_967_296;
    };
    const bootstraps: number[] = [];
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const sample: DatedRequest[] = [];
      for (let index = 0; index < sessions.length; index += 1) {
        sample.push(...sessions[Math.floor(random() * sessions.length)]);
      }
      const result = calculate(sample);
      if (result != null) bootstraps.push(result);
    }
    if (bootstraps.length > 0) {
      ciLow = quantile(bootstraps, 0.025);
      ciHigh = quantile(bootstraps, 0.975);
    }
  }

  let percentile: number | null = null;
  if (options.percentile !== false) {
    const baselineByDate = new Map<string, DatedRequest[]>();
    for (const request of baseline) {
      const group = baselineByDate.get(request.date) ?? [];
      group.push(request);
      baselineByDate.set(request.date, group);
    }
    const historicalIndices = [...baselineByDate.values()]
      .map((requests) => calculate(requests))
      .filter((item): item is number => item != null);
    percentile =
      value != null && historicalIndices.length > 0
        ? (historicalIndices.filter((item) => item <= value).length / historicalIndices.length) *
          100
        : null;
  }
  return { value, ciLow, ciHigh, percentile, eligible: reason == null, reason };
}

function niceHistogram(requests: readonly StoredRequest[]): HistogramBin[] {
  const values = metrics(requests).map(({ value }) => value);
  if (values.length === 0) return [];
  const maximum = Math.max(...values);
  const iqr = quantile(values, 0.75) - quantile(values, 0.25);
  const rawWidth = iqr > 0 ? (2 * iqr) / Math.cbrt(values.length) : maximum / 12;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rawWidth, 1)));
  const ratio = rawWidth / magnitude;
  const width = (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10) * magnitude;
  const binCount = Math.max(1, Math.min(40, Math.ceil(maximum / width)));
  const overflowUpper = width * binCount;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    lower: index * width,
    upper: (index + 1) * width,
    count: 0,
  }));
  for (const value of values) {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor(value / width)));
    bins[index].count += 1;
  }
  // Ensure the final upper bound includes floating-point edge values.
  bins[bins.length - 1].upper = Math.max(overflowUpper, maximum);
  return bins;
}

export class Analytics {
  #requestSnapshot: { revision: number; requests: StoredRequest[] } | null = null;
  #datedSnapshots = new Map<string, DatedSnapshot>();

  constructor(readonly database: Database) {}

  private requests(): StoredRequest[] {
    const revision = this.database.getRequestRevision();
    if (this.#requestSnapshot?.revision !== revision) {
      this.#requestSnapshot = { revision, requests: this.database.getRequests() };
      this.#datedSnapshots.clear();
    }
    return this.#requestSnapshot.requests;
  }

  private dated(timezone: string): DatedSnapshot {
    this.requests();
    const cached = this.#datedSnapshots.get(timezone);
    if (cached) return cached;
    const includingProvisional = this.requests()
      .filter(
        (request): request is StoredRequest & { finishedAt: number } =>
          request.finishedAt != null &&
          request.qualityReason == null &&
          request.tokensPerSecond != null,
      )
      .map((request) => ({ ...request, date: localDate(request.finishedAt, timezone) }));
    const snapshot = {
      includingProvisional,
      completed: includingProvisional.filter((request) => !request.provisional),
    };
    this.#datedSnapshots.set(timezone, snapshot);
    return snapshot;
  }

  private refusalTimeline(timezone: string, start: string, end: string): RefusalTimeline {
    const refusals = this.database.getRefusals();
    const requestsById = new Map(
      this.requests().map((request) => [request.requestId, request] as const),
    );
    const dates = new Map<
      string,
      { families: Map<ModelFamily, RefusalCounts>; unattributed: RefusalCounts }
    >();
    for (const refusal of refusals) {
      const date = localDate(refusal.timestampMs, timezone);
      if (date < start || date > end) continue;
      const summary = dates.get(date) ?? {
        families: new Map<ModelFamily, RefusalCounts>(),
        unattributed: emptyRefusalCounts(),
      };
      const request = refusal.requestId ? requestsById.get(refusal.requestId) : undefined;
      const family = request ? attributableFamily(request) : undefined;
      if (family) {
        const counts = summary.families.get(family) ?? emptyRefusalCounts();
        addRefusalOutcome(counts, refusal.outcome);
        summary.families.set(family, counts);
      } else {
        addRefusalOutcome(summary.unattributed, refusal.outcome);
      }
      dates.set(date, summary);
    }
    return {
      recorded: refusals.length > 0,
      days: [...dates.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, summary]) => ({
          date,
          families: MODEL_FAMILIES.flatMap((family) => {
            const counts = summary.families.get(family);
            return counts ? [{ family, ...counts }] : [];
          }),
          unattributed: summary.unattributed,
        })),
    };
  }

  private failureTimeline(timezone: string, start: string, end: string): FailureTimeline {
    const failures = this.database.getFailures();
    return { recorded: failures.length > 0, days: failureDays(failures, timezone, start, end) };
  }

  private periodRefusals(timezone: string, start: string, end: string): PeriodRefusalSummary {
    const timeline = this.refusalTimeline(timezone, start, end);
    const total = emptyRefusalCounts();
    const affectedDates = timeline.days.map((day) => {
      const counts = emptyRefusalCounts();
      for (const family of day.families) addRefusalCounts(counts, family);
      addRefusalCounts(counts, day.unattributed);
      addRefusalCounts(total, counts);
      return { date: day.date, ...counts };
    });
    return { recorded: timeline.recorded, ...total, affectedDates };
  }

  overview(timezone = 'UTC', now: Date = new Date()): OverviewResponse {
    validateTimezone(timezone);
    const today = localDate(now.getTime(), timezone);
    const all = this.requests();
    const quality = this.database.getDataQuality();
    const { includingProvisional: validIncludingProvisional, completed: valid } =
      this.dated(timezone);
    const todaysRequests = valid.filter((request) => request.date === today);
    const todaysProvisional = validIncludingProvisional.filter(
      (request) => request.date === today && request.provisional,
    );
    const baselineStart = addCalendarDays(today, -28);
    const baseline = valid.filter(
      (request) => request.date >= baselineStart && request.date < today,
    );
    const headlineOutput = todaysRequests.reduce(
      (total, request) => total + request.outputTokens,
      0,
    );
    const weekStart = addCalendarDays(today, 1 - isoWeekday(today));
    const weekEnd = addCalendarDays(weekStart, 7);
    const weeklyRefusals = this.periodRefusals(timezone, weekStart, today);
    const usageByDate = new Map<string, number>();
    for (const request of all) {
      if (
        request.finishedAt == null ||
        request.outputTokens <= 0 ||
        request.qualityReason === 'synthetic' ||
        request.provisional
      ) {
        continue;
      }
      const date = localDate(request.finishedAt, timezone);
      usageByDate.set(date, (usageByDate.get(date) ?? 0) + request.outputTokens);
    }
    const usageBetween = (start: string, end: string): number => {
      let total = 0;
      for (const [date, outputTokens] of usageByDate) {
        if (date >= start && date < end) total += outputTokens;
      }
      return total;
    };
    const weeklyTokens = usageBetween(weekStart, weekEnd);
    const weeklyRequests = valid.filter(
      (request) => request.date >= weekStart && request.date <= today,
    );
    const weeklyBaselineStart = addCalendarDays(weekStart, -28);
    const weeklyBaseline = valid.filter(
      (request) => request.date >= weeklyBaselineStart && request.date < weekStart,
    );
    const weeklyByDate = new Map<string, DatedRequest[]>();
    for (const request of weeklyRequests) {
      const group = weeklyByDate.get(request.date) ?? [];
      group.push(request);
      weeklyByDate.set(request.date, group);
    }
    const measuredDays = [...weeklyByDate.entries()]
      .flatMap(([date, requests]) => {
        const value = median(metrics(requests).map(({ value }) => value));
        return value === null ? [] : [{ date, median: value }];
      })
      .sort((left, right) => left.date.localeCompare(right.date));
    const fastestDay =
      [...measuredDays].sort(
        (left, right) => right.median - left.median || left.date.localeCompare(right.date),
      )[0] ?? null;
    const slowestDay =
      [...measuredDays].sort(
        (left, right) => left.median - right.median || left.date.localeCompare(right.date),
      )[0] ?? null;
    const weeklySpeedIndex = speedIndex(weeklyRequests, weeklyBaseline, {
      confidence: false,
      percentile: false,
    });
    const weekStartMs = zonedMidnight(weekStart, timezone);
    const weekEndMs = zonedMidnight(weekEnd, timezone);
    const elapsedFraction = Math.max(
      0,
      Math.min(1, (now.getTime() - weekStartMs) / (weekEndMs - weekStartMs)),
    );
    const priorWeeks: number[] = [];
    for (let weeksAgo = 1; weeksAgo <= 4; weeksAgo += 1) {
      const start = addCalendarDays(weekStart, -7 * weeksAgo);
      const end = addCalendarDays(start, 7);
      priorWeeks.push(usageBetween(start, end));
    }
    return {
      generatedAt: now.toISOString(),
      timezone,
      today,
      headline: {
        ...summarize(metrics(todaysRequests)),
        outputTokens: headlineOutput,
        provisional: todaysProvisional.length,
      },
      speedIndex: speedIndex(todaysRequests, baseline),
      models: modelSummaries(todaysRequests),
      weekly: {
        outputTokens: weeklyTokens,
        projectedOutputTokens: elapsedFraction >= 0.01 ? weeklyTokens / elapsedFraction : null,
        elapsedFraction,
        previousFourWeekMedian: median(priorWeeks),
        recap: {
          weekStart,
          throughDate: today,
          daysObserved: measuredDays.length,
          observedDates: measuredDays.map(({ date }) => date),
          requestCount: weeklyRequests.length,
          sessions: new Set(weeklyRequests.map(({ sessionId }) => sessionId)).size,
          median: median(metrics(weeklyRequests).map(({ value }) => value)),
          speedIndex: weeklySpeedIndex,
          models: weeklyModelMix(weeklyRequests),
          fastestDay,
          slowestDay,
          refusals: weeklyRefusals,
        },
      },
      // Both rates divide by the same measured-request count, and the query
      // behind it is expensive, so it is read once and threaded through.
      refusals: this.refusals(timezone, quality),
      failures: this.failures(timezone, quality),
      scan: this.database.getScanStatus(),
    };
  }

  series(days = 30, timezone = 'UTC', now: Date = new Date()): SeriesResponse {
    validateTimezone(timezone);
    const boundedDays = Math.max(1, Math.min(3660, Math.floor(days)));
    const today = localDate(now.getTime(), timezone);
    const start = addCalendarDays(today, 1 - boundedDays);
    const requestsIncludingProvisional = this.dated(timezone).includingProvisional.filter(
      (request) => request.date >= start && request.date <= today,
    );
    const groups = new Map<string, DatedRequest[]>();
    const provisionalCounts = new Map<string, number>();
    const completedDates = new Set<string>();
    for (const request of requestsIncludingProvisional) {
      const key = `${request.date}:${request.family}`;
      if (request.provisional) {
        provisionalCounts.set(key, (provisionalCounts.get(key) ?? 0) + 1);
      } else {
        const group = groups.get(key) ?? [];
        group.push(request);
        groups.set(key, group);
        completedDates.add(request.date);
      }
    }
    const points: DailyPoint[] = [];
    const dates = [...completedDates].sort();
    for (const date of dates) {
      for (const family of MODEL_FAMILIES) {
        const key = `${date}:${family}`;
        const selected = groups.get(key) ?? [];
        if (selected.length === 0) continue;
        points.push({
          date,
          family,
          ...summarize(metrics(selected)),
          outputTokens: selected.reduce((total, request) => total + request.outputTokens, 0),
          provisional: provisionalCounts.get(key) ?? 0,
        });
      }
    }
    return {
      timezone,
      days: boundedDays,
      points,
      refusals: this.refusalTimeline(timezone, start, today),
      failures: this.failureTimeline(timezone, start, today),
    };
  }

  longitudinal(
    days: 28 | 90 | 365,
    families: readonly ModelFamily[],
    timezone = 'UTC',
    now: Date = new Date(),
  ): LongitudinalSummary {
    validateTimezone(timezone);
    if (![28, 90, 365].includes(days)) throw new TypeError('days must be 28, 90, or 365');
    const selectedFamilies = MODEL_FAMILIES.filter((family) => families.includes(family));
    if (selectedFamilies.length === 0)
      throw new TypeError('At least one model family is required.');
    const selectedFamilySet = new Set(selectedFamilies);
    const throughDate = localDate(now.getTime(), timezone);
    const startDate = addCalendarDays(throughDate, 1 - days);
    const selected = this.dated(timezone).completed.filter(
      (request) =>
        request.date >= startDate &&
        request.date <= throughDate &&
        selectedFamilySet.has(request.family),
    );
    const measuredOutputTokens = selected.reduce(
      (total, request) => total + request.outputTokens,
      0,
    );
    const observedDays = new Set(selected.map((request) => request.date)).size;
    const stratumKey = (request: StoredRequest): string => `${request.family}:${request.stratum}`;
    const strata = new Map<string, DatedRequest[]>();
    for (const request of selected) {
      const key = stratumKey(request);
      const group = strata.get(key) ?? [];
      group.push(request);
      strata.set(key, group);
    }
    const usable = [...strata.entries()].flatMap(([key, requests]) => {
      if (requests.length < 30 || new Set(requests.map((request) => request.date)).size < 5)
        return [];
      const center = median(metrics(requests).map(({ value }) => value));
      return center !== null && center > 0 ? [{ key, center, weight: requests.length }] : [];
    });
    const usableKeys = new Set(usable.map(({ key }) => key));
    const comparableRequests = selected.filter((request) => usableKeys.has(stratumKey(request)));
    const comparableRequestCoverage =
      selected.length > 0 ? comparableRequests.length / selected.length : 0;
    const totalWeight = usable.reduce((total, item) => total + item.weight, 0);
    const byDate = new Map<string, DatedRequest[]>();
    for (const request of selected) {
      const group = byDate.get(request.date) ?? [];
      group.push(request);
      byDate.set(request.date, group);
    }
    const points = [...byDate.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([date, requests]) => {
        if (requests.length < 20 || totalWeight === 0) return [];
        const dayStrata = new Map<string, DatedRequest[]>();
        for (const request of requests) {
          const key = stratumKey(request);
          const group = dayStrata.get(key) ?? [];
          group.push(request);
          dayStrata.set(key, group);
        }
        let availableWeight = 0;
        let weightedLogRatio = 0;
        for (const item of usable) {
          const candidates = dayStrata.get(item.key) ?? [];
          if (candidates.length < 2) continue;
          const dayMedian = median(metrics(candidates).map(({ value }) => value));
          if (dayMedian === null || dayMedian <= 0) continue;
          availableWeight += item.weight;
          weightedLogRatio += Math.log(dayMedian / item.center) * item.weight;
        }
        const coverage = availableWeight / totalWeight;
        if (coverage < 0.7 || availableWeight === 0) return [];
        return [
          {
            date,
            index: Math.exp(weightedLogRatio / availableWeight) * 100,
            requestCount: requests.length,
            coverage,
          },
        ];
      });
    const qualifiedRequests = points.reduce((total, point) => total + point.requestCount, 0);
    const elapsedSpan = points.length > 0 ? daysBetween(points[0].date, points.at(-1)!.date) : 0;
    const calendarSpan = points.length > 0 ? elapsedSpan + 1 : 0;
    let quality: LongitudinalSummary['quality'] = 'insufficient';
    if (
      points.length >= 20 &&
      calendarSpan >= 28 &&
      qualifiedRequests >= 400 &&
      comparableRequestCoverage >= 0.8
    ) {
      quality = 'robust';
    } else if (
      points.length >= 7 &&
      calendarSpan >= 14 &&
      qualifiedRequests >= 100 &&
      comparableRequestCoverage >= 0.7
    ) {
      quality = 'directional';
    }
    let variationPct: number | null = null;
    let trendPct: number | null = null;
    if (quality !== 'insufficient' && points.length >= 2) {
      const firstDate = points[0].date;
      const fitted = theilSen(
        points.map((point) => ({
          x: daysBetween(firstDate, point.date),
          y: Math.log(point.index),
        })),
      );
      if (fitted) {
        const residuals = points.map((point) => {
          const x = daysBetween(firstDate, point.date);
          return Math.abs(Math.log(point.index) - (fitted.intercept + fitted.slope * x));
        });
        const typicalResidual = median(residuals);
        variationPct = typicalResidual === null ? null : (Math.exp(typicalResidual) - 1) * 100;
        trendPct = (Math.exp(fitted.slope * elapsedSpan) - 1) * 100;
      }
    }
    const timeline = this.refusalTimeline(timezone, startDate, throughDate);
    const refusalDays = timeline.days.flatMap((day) => {
      const selectedCounts = emptyRefusalCounts();
      for (const family of day.families) {
        if (selectedFamilySet.has(family.family)) addRefusalCounts(selectedCounts, family);
      }
      return selectedCounts.attempted > 0 || day.unattributed.attempted > 0
        ? [{ date: day.date, selected: selectedCounts, unattributed: day.unattributed }]
        : [];
    });
    return {
      timezone,
      days,
      startDate,
      throughDate,
      families: selectedFamilies,
      observedDays,
      measuredRequests: selected.length,
      measuredOutputTokens,
      qualifiedDays: points.length,
      comparableRequestCoverage,
      quality,
      variationPct,
      trendPct,
      points,
      refusalsRecorded: timeline.recorded,
      refusals: refusalDays,
    };
  }

  day(date: string, timezone = 'UTC'): DayDetailResponse | null {
    validateTimezone(timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError('Date must be YYYY-MM-DD');
    const all = this.requests();
    const selectedAll = all.filter(
      (request) => request.finishedAt != null && localDate(request.finishedAt, timezone) === date,
    );
    if (selectedAll.length === 0) return null;
    const selected = selectedAll.filter(
      (request) =>
        request.qualityReason == null && request.tokensPerSecond != null && !request.provisional,
    );
    const baselineStart = addCalendarDays(date, -28);
    const baseline = this.dated(timezone).completed.filter(
      (request) => request.date >= baselineStart && request.date < date,
    );
    const exclusions: Record<string, number> = {};
    for (const request of selectedAll) {
      if (request.qualityReason)
        exclusions[request.qualityReason] = (exclusions[request.qualityReason] ?? 0) + 1;
      else if (request.provisional) exclusions.provisional = (exclusions.provisional ?? 0) + 1;
    }
    const requestsByHour = Array.from({ length: 24 }, () => [] as StoredRequest[]);
    for (const request of selected) {
      requestsByHour[zonedParts(request.finishedAt as number, timezone).hour].push(request);
    }
    const hourly = requestsByHour.map((requests, hour) => {
      return {
        hour,
        median: median(metrics(requests).map(({ value }) => value)),
        count: requests.length,
      };
    });
    return {
      date,
      timezone,
      summary: {
        ...summarize(metrics(selected)),
        outputTokens: selected.reduce((total, request) => total + request.outputTokens, 0),
      },
      speedIndex: speedIndex(
        selected.map((request) => ({ ...request, date })),
        baseline,
      ),
      models: modelSummaries(selected),
      histogram: niceHistogram(selected),
      hourly,
      exclusions,
    };
  }

  refusals(timezone = 'UTC', quality?: DataQualitySummary): RefusalSummary {
    validateTimezone(timezone);
    const refusals = this.database.getRefusals();
    const dates = new Map<string, { attempted: number; recovered: number; userVisible: number }>();
    let recovered = 0;
    let userVisible = 0;
    let unknown = 0;
    for (const refusal of refusals) {
      if (refusal.outcome === 'recovered') recovered += 1;
      else if (refusal.outcome === 'user_visible') userVisible += 1;
      else unknown += 1;
      const date = localDate(refusal.timestampMs, timezone);
      const summary = dates.get(date) ?? { attempted: 0, recovered: 0, userVisible: 0 };
      summary.attempted += 1;
      if (refusal.outcome === 'recovered') summary.recovered += 1;
      if (refusal.outcome === 'user_visible') summary.userVisible += 1;
      dates.set(date, summary);
    }
    // The copy promises a rate per 1,000 *measured* requests, so the
    // denominator excludes the requests that were dropped from measurement.
    const measured = (quality ?? this.database.getDataQuality()).includedRequests;
    return {
      recorded: refusals.length > 0,
      attempted: refusals.length,
      recovered,
      userVisible,
      unknown,
      perThousand: measured > 0 ? (refusals.length / measured) * 1_000 : null,
      byDay: [...dates.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, summary]) => ({ date, ...summary })),
    };
  }

  failures(timezone = 'UTC', quality?: DataQualitySummary): FailureSummary {
    validateTimezone(timezone);
    const failures = this.database.getFailures();
    const byDay = failureDays(failures, timezone);
    const total = emptyFailureCounts();
    for (const day of byDay) {
      total.attempted += day.attempted;
      total.overloaded += day.overloaded;
      total.serverError += day.serverError;
    }
    // Same measured-request denominator as refusals, so the two rates compare.
    const measured = (quality ?? this.database.getDataQuality()).includedRequests;
    return {
      recorded: failures.length > 0,
      ...total,
      perThousand: measured > 0 ? (total.attempted / measured) * 1_000 : null,
      byDay,
    };
  }

  quota(now: Date = new Date()): QuotaResponse {
    return this.database.getQuota(now);
  }

  dataQuality(): DataQualitySummary {
    return this.database.getDataQuality();
  }
}

export type { DataQualitySummary } from '../server/database';
