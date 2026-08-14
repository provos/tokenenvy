import type { HistogramBin, ModelSummary, SpeedIndex } from '$lib/types';

export type ShareTone = 'friendly' | 'spicy';
export type SharePlatform = 'generic' | 'x' | 'bluesky' | 'linkedin';

export interface ShareHistogramBar {
	lower: number;
	upper: number;
	count: number;
	height: number;
	containsMedian: boolean;
}

export interface ShareCardData {
	date: string;
	median: number;
	count: number;
	sessions: number;
	outputTokens: number;
	isToday: boolean;
	indexLabel: string;
	indexEligible: boolean;
	percentile: number | null;
	models: Array<{ family: string; median: number; count: number }>;
	histogram: Array<{ lower: number; upper: number; count: number }>;
}

export interface ShareCardInput {
	date: string;
	median: number;
	count: number;
	sessions: number;
	outputTokens: number;
	isToday: boolean;
	speedIndex: SpeedIndex;
	models: ModelSummary[];
	histogram: HistogramBin[];
}

export interface ShareProductLink {
	href: string;
	label: string;
}

export function safeShareProductLink(value: string | undefined): ShareProductLink | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== 'https:' ||
			url.href.length > 2048 ||
			url.username ||
			url.password
		) {
			return null;
		}
		const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
		const label = `${url.host}${path}`;
		return { href: url.href, label: label.length > 48 ? `${label.slice(0, 47)}…` : label };
	} catch {
		return null;
	}
}

export function speedIndexDelta(index: SpeedIndex): number | null {
	if (!index.eligible || index.value === null) return null;
	return Math.round(index.value - 100);
}

export function speedIndexLabel(index: SpeedIndex): string {
	const delta = speedIndexDelta(index);
	if (delta === null) return 'Baseline warming up';
	if (delta === 0) return 'Right at your baseline';
	return `${delta > 0 ? '+' : ''}${delta}% vs your baseline`;
}

function sanitizeHistogram(histogram: HistogramBin[]): Array<{ lower: number; upper: number; count: number }> {
	return histogram
		.filter(
			(bin) =>
				Number.isFinite(bin.lower) &&
				Number.isFinite(bin.upper) &&
				Number.isFinite(bin.count) &&
				bin.upper > bin.lower &&
				bin.count >= 0,
		)
		.slice(0, 40)
		.map((bin) => ({
			lower: bin.lower,
			upper: bin.upper,
			count: Math.round(bin.count),
		}));
}

export function normalizeHistogram(
	histogram: Array<{ lower: number; upper: number; count: number }>,
	median: number,
): ShareHistogramBar[] {
	const bins = sanitizeHistogram(histogram);
	const maximum = Math.max(1, ...bins.map((bin) => bin.count));
	const medianIndex = bins.findIndex(
		(bin, index) =>
			median >= bin.lower &&
			(median < bin.upper || (index === bins.length - 1 && median <= bin.upper)),
	);

	return bins.map((bin, index) => ({
		...bin,
		height: bin.count / maximum,
		containsMedian: index === medianIndex,
	}));
}

export function buildShareCardData(input: ShareCardInput): ShareCardData {
	return {
		date: input.date,
		median: input.median,
		count: input.count,
		sessions: input.sessions,
		outputTokens: input.outputTokens,
		isToday: input.isToday,
		indexLabel: speedIndexLabel(input.speedIndex),
		indexEligible: input.speedIndex.eligible,
		percentile: input.speedIndex.percentile,
		models: [...input.models].sort((left, right) => right.share - left.share).slice(0, 8).map((model) => ({
			family: model.family,
			median: model.median,
			count: model.count,
		})),
		histogram: sanitizeHistogram(input.histogram),
	};
}

function ordinal(value: number): string {
	const rounded = Math.round(value);
	const modulo100 = rounded % 100;
	const suffix =
		modulo100 >= 11 && modulo100 <= 13
			? 'th'
			: rounded % 10 === 1
				? 'st'
				: rounded % 10 === 2
					? 'nd'
					: rounded % 10 === 3
						? 'rd'
						: 'th';
	return `${rounded}${suffix}`;
}

export function getShareMoodLine(data: ShareCardData): string {
	if (!data.indexEligible || data.percentile === null) {
		return `Baseline warming up · ${data.count.toLocaleString('en-US')} measured requests`;
	}

	const mood = data.percentile >= 75 ? 'Flying' : data.percentile <= 25 ? 'Scenic route' : 'Cruising';
	return `${mood} · ${ordinal(data.percentile)} percentile in my comparable days`;
}

export function getShareTagline(tone: ShareTone, data: ShareCardData): string {
	const percentile = data.indexEligible ? data.percentile : null;

	if (tone === 'friendly') {
		if (percentile !== null && percentile >= 75) {
			return data.isToday ? 'Claude Code is flying today' : 'Claude Code was flying that day';
		}
		if (percentile !== null && percentile <= 25) {
			return data.isToday
				? 'Claude Code is taking the scenic route today'
				: 'Claude Code took the scenic route that day';
		}
		return data.isToday ? 'Claude Code found its rhythm today' : 'Claude Code found its rhythm that day';
	}

	if (percentile !== null && percentile >= 75) {
		return data.isToday ? 'Anthropic loves me today' : 'Anthropic loved me that day';
	}
	if (percentile !== null && percentile <= 25) {
		return data.isToday ? 'Anthropic hates me today' : 'Anthropic hated me that day';
	}
	return data.isToday
		? 'Anthropic and I are on speaking terms'
		: 'Anthropic and I were on speaking terms';
}

export function getShareCaption(
	tone: ShareTone,
	data: ShareCardData,
	platform: SharePlatform,
	productLink: string | null,
): string {
	const base = `${getShareTagline(tone, data)}: ${Math.round(data.median)} effective output tokens/s — ${getShareMoodLine(data)}. #TokenEnvy`;
	if ((platform === 'bluesky' || platform === 'generic') && productLink) {
		return `${base} ${productLink}`;
	}
	return base;
}
