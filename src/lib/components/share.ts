import type { HistogramBin, ModelSummary, SpeedIndex } from '$lib/types';
import { SECURITY_BLUEPRINTS_CAPTION } from './brand';

export type ShareTone = 'friendly' | 'spicy';
export type ShareSentiment = -2 | -1 | 0 | 1 | 2;
export type SharePlatform = 'generic' | 'x' | 'bluesky' | 'linkedin';
export const SHARE_INSTALL_CTA = 'Run it yourself · npx tokenenvy';
export const DEFAULT_SHARE_PRODUCT_URL = 'https://www.npmjs.com/package/tokenenvy';

export interface ShareSentimentTheme {
	value: ShareSentiment;
	label: string;
	accessibleLabel: string;
	backgroundStart: string;
	backgroundMiddle: string;
	backgroundEnd: string;
	accent: string;
	secondary: string;
	text: string;
	mutedText: string;
	glow: string;
	bar: string;
	medianBar: string;
	outline: string;
}

export const SHARE_SENTIMENTS: readonly ShareSentiment[] = [-2, -1, 0, 1, 2];

const SENTIMENT_THEMES: Record<ShareSentiment, ShareSentimentTheme> = {
	[-2]: {
		value: -2,
		label: 'Brutal',
		accessibleLabel: 'Very negative',
		backgroundStart: '#160d18',
		backgroundMiddle: '#351522',
		backgroundEnd: '#53251f',
		accent: '#ff746c',
		secondary: '#c9dc58',
		text: '#fff3ef',
		mutedText: 'rgba(255, 243, 239, 0.76)',
		glow: 'rgba(255, 116, 108, 0.22)',
		bar: 'rgba(201, 220, 88, 0.25)',
		medianBar: 'rgba(255, 116, 108, 0.78)',
		outline: 'rgba(22, 13, 24, 0.82)',
	},
	[-1]: {
		value: -1,
		label: 'Rough',
		accessibleLabel: 'Negative',
		backgroundStart: '#17101b',
		backgroundMiddle: '#34202e',
		backgroundEnd: '#51342f',
		accent: '#ff9b72',
		secondary: '#dfbd70',
		text: '#fff5ef',
		mutedText: 'rgba(255, 245, 239, 0.76)',
		glow: 'rgba(255, 155, 114, 0.2)',
		bar: 'rgba(223, 189, 112, 0.24)',
		medianBar: 'rgba(255, 155, 114, 0.76)',
		outline: 'rgba(23, 16, 27, 0.82)',
	},
	[0]: {
		value: 0,
		label: 'Neutral',
		accessibleLabel: 'Neutral',
		backgroundStart: '#0d131b',
		backgroundMiddle: '#1b2730',
		backgroundEnd: '#293b45',
		accent: '#d8e1e8',
		secondary: '#7fa8b5',
		text: '#f3f6f8',
		mutedText: 'rgba(243, 246, 248, 0.74)',
		glow: 'rgba(127, 168, 181, 0.18)',
		bar: 'rgba(127, 168, 181, 0.25)',
		medianBar: 'rgba(216, 225, 232, 0.7)',
		outline: 'rgba(13, 19, 27, 0.82)',
	},
	[1]: {
		value: 1,
		label: 'Good',
		accessibleLabel: 'Positive',
		backgroundStart: '#07151b',
		backgroundMiddle: '#0c3032',
		backgroundEnd: '#154a3f',
		accent: '#6ff0c0',
		secondary: '#a6ed77',
		text: '#effff9',
		mutedText: 'rgba(239, 255, 249, 0.76)',
		glow: 'rgba(111, 240, 192, 0.2)',
		bar: 'rgba(166, 237, 119, 0.24)',
		medianBar: 'rgba(111, 240, 192, 0.76)',
		outline: 'rgba(7, 21, 27, 0.82)',
	},
	[2]: {
		value: 2,
		label: 'Glorious',
		accessibleLabel: 'Very positive',
		backgroundStart: '#0e1028',
		backgroundMiddle: '#242153',
		backgroundEnd: '#482b63',
		accent: '#ffd56a',
		secondary: '#7ae8ff',
		text: '#fffaf0',
		mutedText: 'rgba(255, 250, 240, 0.78)',
		glow: 'rgba(255, 213, 106, 0.23)',
		bar: 'rgba(122, 232, 255, 0.24)',
		medianBar: 'rgba(255, 213, 106, 0.82)',
		outline: 'rgba(14, 16, 40, 0.84)',
	},
};

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
	indexValue: number | null;
	indexCiLow: number | null;
	indexCiHigh: number | null;
	percentile: number | null;
	refusals: ShareRefusalCounts;
	models: Array<{ family: string; median: number; count: number }>;
	histogram: Array<{ lower: number; upper: number; count: number }>;
}

export interface ShareRefusalCounts {
	recorded: boolean;
	attempted: number;
	recovered: number;
	userVisible: number;
}

export interface ShareCardInput {
	date: string;
	median: number;
	count: number;
	sessions: number;
	outputTokens: number;
	isToday: boolean;
	speedIndex: SpeedIndex;
	refusals?: ShareRefusalCounts;
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
	if (delta === null) return 'Building my personal baseline';
	if (delta === 0) return 'Right at your baseline';
	return `${delta > 0 ? '+' : ''}${delta}% vs your baseline`;
}

export function normalizeShareSentiment(value: number): ShareSentiment {
	const rounded = Math.max(-2, Math.min(2, Math.round(value)));
	return rounded as ShareSentiment;
}

export function getShareSentimentTheme(value: number): ShareSentimentTheme {
	return SENTIMENT_THEMES[normalizeShareSentiment(value)];
}

export function sentimentAfterCardChange(
	previousDate: string | null,
	nextDate: string,
	current: ShareSentiment,
	suggested: ShareSentiment,
): ShareSentiment {
	return previousDate === nextDate ? current : suggested;
}

export function suggestedShareSentiment(data: ShareCardData): ShareSentiment {
	const { indexValue, indexCiLow, indexCiHigh, percentile } = data;
	if (!data.indexEligible || indexValue === null || percentile === null) return 0;

	if (
		percentile <= 10 &&
		indexValue <= 90 &&
		indexCiHigh !== null &&
		indexCiHigh < 100
	) {
		return -2;
	}
	if (percentile <= 45 && indexValue < 100) return -1;

	if (
		percentile >= 90 &&
		indexValue >= 110 &&
		indexCiLow !== null &&
		indexCiLow > 100
	) {
		return 2;
	}
	if (percentile >= 55 && indexValue > 100) return 1;
	return 0;
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
	const attempted = input.refusals?.recorded ? nonNegativeInteger(input.refusals.attempted) : 0;
	const recovered = Math.min(attempted, nonNegativeInteger(input.refusals?.recovered));
	const userVisible = Math.min(
		attempted - recovered,
		nonNegativeInteger(input.refusals?.userVisible),
	);
	return {
		date: input.date,
		median: input.median,
		count: input.count,
		sessions: input.sessions,
		outputTokens: input.outputTokens,
		isToday: input.isToday,
		indexLabel: speedIndexLabel(input.speedIndex),
		indexEligible: input.speedIndex.eligible,
		indexValue: input.speedIndex.value,
		indexCiLow: input.speedIndex.ciLow,
		indexCiHigh: input.speedIndex.ciHigh,
		percentile: input.speedIndex.percentile,
		refusals: {
			recorded: input.refusals?.recorded === true,
			attempted,
			recovered,
			userVisible,
		},
		models: [...input.models].sort((left, right) => right.share - left.share).slice(0, 8).map((model) => ({
			family: model.family,
			median: model.median,
			count: model.count,
		})),
		histogram: sanitizeHistogram(input.histogram),
	};
}

function nonNegativeInteger(value: number | undefined): number {
	return Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : 0;
}

export function getShareMoodLine(data: ShareCardData): string {
	if (!data.indexEligible || data.percentile === null) {
		return 'Building my personal baseline';
	}

	const percentile = Math.max(0, Math.min(100, Math.round(data.percentile)));
	if (percentile === 100) return 'Fastest among my comparable days';
	if (percentile === 0) return 'At the slow end of my comparable days';
	return `Faster than ${percentile}% of my comparable days`;
}

export function getShareRefusalLine(data: ShareCardData): string {
	if (!data.refusals.recorded) return 'Refusals: explicit signals unavailable';
	const { attempted, recovered, userVisible } = data.refusals;
	if (attempted === 0) return '';
	const unknown = Math.max(0, attempted - recovered - userVisible);
	const outcomes = [
		recovered > 0 ? `${recovered} recovered` : null,
		userVisible > 0 ? `${userVisible} user-visible` : null,
		unknown > 0 ? `${unknown} unresolved` : null,
	].filter((value): value is string => value !== null);
	const label = attempted === 1 ? 'refusal' : 'refusals';
	return `${attempted} ${label}${outcomes.length > 0 ? ` · ${outcomes.join(' · ')}` : ''}`;
}

export function getShareImageFilename(
	date: string,
	tone: ShareTone,
	sentiment: number,
): string {
	const safeDate =
		date
			.trim()
			.replace(/[^a-zA-Z0-9-]+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 32) || 'day';
	const safeTone: ShareTone = tone === 'spicy' ? 'spicy' : 'friendly';
	const mood = getShareSentimentTheme(sentiment).label.toLowerCase();
	return `token-envy-${safeDate}-${safeTone}-${mood}.png`;
}

export function getShareTagline(
	tone: ShareTone,
	sentiment: ShareSentiment,
	data: ShareCardData,
): string {
	const when = data.isToday ? 'today' : 'that day';
	if (tone === 'friendly') {
		if (sentiment === -2) return `Claude Code chose hard mode ${when}`;
		if (sentiment === -1) return `Claude Code took the scenic route ${when}`;
		if (sentiment === 0) return `Claude Code kept it steady ${when}`;
		if (sentiment === 1) return `Claude Code found another gear ${when}`;
		return `Claude Code ${data.isToday ? 'is' : 'was'} flying ${when}`;
	}

	if (sentiment === -2) return `Anthropic ${data.isToday ? 'hates' : 'hated'} me ${when}`;
	if (sentiment === -1) return `Anthropic ${data.isToday ? 'is' : 'was'} testing me ${when}`;
	if (sentiment === 0) {
		return data.isToday
			? 'Anthropic and I are on speaking terms'
			: 'Anthropic and I were on speaking terms';
	}
	if (sentiment === 1) return `Anthropic ${data.isToday ? 'likes' : 'liked'} me ${when}`;
	return `Anthropic ${data.isToday ? 'loves' : 'loved'} me ${when}`;
}

export function getShareCaption(
	tone: ShareTone,
	sentiment: ShareSentiment,
	data: ShareCardData,
	platform: SharePlatform,
	productLink: string | null,
): string {
	const tagline = getShareTagline(tone, sentiment, data);
	const result = `${Math.round(data.median)} effective output tok/s. ${getShareMoodLine(data)}.`;
	const question = 'How does your Claude Code speed compare?';
	const privacy = 'Measured locally. Prompts stay private.';
	const attribution = `#TokenEnvy. ${SECURITY_BLUEPRINTS_CAPTION}`;
	const link = (platform === 'bluesky' || platform === 'generic') && productLink
		? ` ${productLink}`
		: '';

	if (platform === 'linkedin') {
		return `${tagline}.\n\nMy Token Envy receipt: ${result}\n\n${question}\n\n${privacy}\n${attribution}`;
	}
	return `${tagline}: ${result} ${question} ${privacy} ${attribution}${link}`;
}

export function getShareTextReceipt(
	tone: ShareTone,
	sentiment: ShareSentiment,
	data: ShareCardData,
	productLink: string | null = null,
): string {
	const refusalLine = getShareRefusalLine(data);
	const lines = [
		'Token Envy daily receipt',
		data.date,
		getShareTagline(tone, sentiment, data),
		`${Math.round(data.median)} effective output tokens/s`,
		getShareMoodLine(data),
		`${data.count.toLocaleString('en-US')} measured requests · ${data.sessions.toLocaleString('en-US')} sessions`,
		refusalLine || null,
		refusalLine && data.refusals.recorded
			? 'Refusals reflect explicit transcript signals and remain a lower bound.'
			: null,
		'Measured locally. Prompts stay private.',
		SHARE_INSTALL_CTA,
		SECURITY_BLUEPRINTS_CAPTION,
		productLink,
	].filter((line): line is string => Boolean(line));
	return lines.join('\n');
}
