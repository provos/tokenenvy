import type {
  DailyPoint,
  DayDetailResponse,
  HistogramBin,
  ModelFamily,
  ModelSummary,
  OverviewResponse,
  QuotaResponse,
  RefusalSummary,
  SeriesResponse,
  SpeedIndex
} from '../types';
import { MODEL_FAMILIES } from '../types';
import { Database, type DataQualitySummary, type StoredRequest } from '../server/database';
import { quantile, summarize, type MetricSample } from './statistics';
import {
  addCalendarDays,
  isoWeekday,
  localDate,
  validateTimezone,
  zonedMidnight,
  zonedParts
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
    .filter((request) => request.tokensPerSecond != null && Number.isFinite(request.tokensPerSecond))
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
    return [{
      family,
      ...summarize(metrics(selected)),
      outputTokens,
      share: totalOutput > 0 ? outputTokens / totalOutput : 0
    }];
  });
}

function median(values: readonly number[]): number | null {
  return values.length > 0 ? quantile(values, 0.5) : null;
}

function speedIndex(current: readonly DatedRequest[], baseline: readonly DatedRequest[]): SpeedIndex {
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
  else if (currentSessions < 5) reason = 'At least five sessions are required.';
  else if (baselineDays < 7) reason = 'At least seven baseline days are required.';
  else if (baseline.length < 100) reason = 'At least 100 baseline requests are required.';
  else if (currentCoverage < 0.7 || baselineCoverage < 0.7 || value == null) {
    reason = 'Not enough comparable model and output-size coverage.';
  }

  let ciLow: number | null = null;
  let ciHigh: number | null = null;
  if (!reason) {
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

  const baselineByDate = new Map<string, DatedRequest[]>();
  for (const request of baseline) {
    const group = baselineByDate.get(request.date) ?? [];
    group.push(request);
    baselineByDate.set(request.date, group);
  }
  const historicalIndices = [...baselineByDate.values()]
    .map((requests) => calculate(requests))
    .filter((item): item is number => item != null);
  const percentile =
    value != null && historicalIndices.length > 0
      ? (historicalIndices.filter((item) => item <= value).length / historicalIndices.length) * 100
      : null;
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
    count: 0
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
          request.tokensPerSecond != null
      )
      .map((request) => ({ ...request, date: localDate(request.finishedAt, timezone) }));
    const snapshot = {
      includingProvisional,
      completed: includingProvisional.filter((request) => !request.provisional)
    };
    this.#datedSnapshots.set(timezone, snapshot);
    return snapshot;
  }

  overview(timezone = 'UTC', now: Date = new Date()): OverviewResponse {
    validateTimezone(timezone);
    const today = localDate(now.getTime(), timezone);
    const all = this.requests();
    const { includingProvisional: validIncludingProvisional, completed: valid } = this.dated(timezone);
    const todaysRequests = valid.filter((request) => request.date === today);
    const todaysProvisional = validIncludingProvisional.filter(
      (request) => request.date === today && request.provisional
    );
    const baselineStart = addCalendarDays(today, -28);
    const baseline = valid.filter((request) => request.date >= baselineStart && request.date < today);
    const headlineOutput = todaysRequests.reduce((total, request) => total + request.outputTokens, 0);
    const weekStart = addCalendarDays(today, 1 - isoWeekday(today));
    const weekEnd = addCalendarDays(weekStart, 7);
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
    const weekStartMs = zonedMidnight(weekStart, timezone);
    const weekEndMs = zonedMidnight(weekEnd, timezone);
    const elapsedFraction = Math.max(0, Math.min(1, (now.getTime() - weekStartMs) / (weekEndMs - weekStartMs)));
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
        provisional: todaysProvisional.length
      },
      speedIndex: speedIndex(todaysRequests, baseline),
      models: modelSummaries(todaysRequests),
      weekly: {
        outputTokens: weeklyTokens,
        projectedOutputTokens: elapsedFraction >= 0.01 ? weeklyTokens / elapsedFraction : null,
        elapsedFraction,
        previousFourWeekMedian: median(priorWeeks)
      },
      refusals: this.refusals(timezone),
      scan: this.database.getScanStatus()
    };
  }

  series(days = 30, timezone = 'UTC', now: Date = new Date()): SeriesResponse {
    validateTimezone(timezone);
    const boundedDays = Math.max(1, Math.min(3660, Math.floor(days)));
    const today = localDate(now.getTime(), timezone);
    const start = addCalendarDays(today, 1 - boundedDays);
    const requestsIncludingProvisional = this.dated(timezone).includingProvisional.filter(
      (request) => request.date >= start && request.date <= today
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
          provisional: provisionalCounts.get(key) ?? 0
        });
      }
    }
    return { timezone, days: boundedDays, points };
  }

  day(date: string, timezone = 'UTC'): DayDetailResponse | null {
    validateTimezone(timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError('Date must be YYYY-MM-DD');
    const all = this.requests();
    const selectedAll = all.filter(
      (request) => request.finishedAt != null && localDate(request.finishedAt, timezone) === date
    );
    if (selectedAll.length === 0) return null;
    const selected = selectedAll.filter(
      (request) => request.qualityReason == null && request.tokensPerSecond != null && !request.provisional
    );
    const exclusions: Record<string, number> = {};
    for (const request of selectedAll) {
      if (request.qualityReason) exclusions[request.qualityReason] = (exclusions[request.qualityReason] ?? 0) + 1;
      else if (request.provisional) exclusions.provisional = (exclusions.provisional ?? 0) + 1;
    }
    const requestsByHour = Array.from({ length: 24 }, () => [] as StoredRequest[]);
    for (const request of selected) {
      requestsByHour[zonedParts(request.finishedAt as number, timezone).hour].push(request);
    }
    const hourly = requestsByHour.map((requests, hour) => {
      return { hour, median: median(metrics(requests).map(({ value }) => value)), count: requests.length };
    });
    return {
      date,
      timezone,
      summary: {
        ...summarize(metrics(selected)),
        outputTokens: selected.reduce((total, request) => total + request.outputTokens, 0)
      },
      models: modelSummaries(selected),
      histogram: niceHistogram(selected),
      hourly,
      exclusions
    };
  }

  refusals(timezone = 'UTC'): RefusalSummary {
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
    const requestCount = this.database.getDataQuality().requests;
    return {
      recorded: refusals.length > 0,
      attempted: refusals.length,
      recovered,
      userVisible,
      unknown,
      perThousand: requestCount > 0 ? (refusals.length / requestCount) * 1_000 : null,
      byDay: [...dates.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, summary]) => ({ date, ...summary }))
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
