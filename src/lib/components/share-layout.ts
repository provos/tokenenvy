export const DAILY_SHARE_CARD_LAYOUT = {
	width: 1200,
	height: 630,
	inset: 12,
	header: { top: 38, bottom: 94 },
	headline: { top: 106, bottom: 180 },
	visual: { top: 174, bottom: 410 },
	metric: { top: 250, bottom: 399 },
	comparison: { top: 416, bottom: 454 },
	activity: { top: 462, bottom: 490 },
	footer: { top: 514, bottom: 610 },
} as const;

export interface FittedText {
	fontSize: number;
	lineHeight: number;
	lines: string[];
}

interface FitTextOptions {
	maxWidth: number;
	maxLines: number;
	maxHeight?: number;
	maxFontSize: number;
	minFontSize: number;
	lineHeightRatio?: number;
	measure: (fontSize: number, text: string) => number;
}

function wrapWords(
	text: string,
	fontSize: number,
	maxWidth: number,
	measure: FitTextOptions['measure'],
): string[] {
	const words = text.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
	if (words.length === 0) return [''];

	const lines: string[] = [];
	let current = words[0];
	for (const word of words.slice(1)) {
		const candidate = `${current} ${word}`;
		if (measure(fontSize, candidate) <= maxWidth) current = candidate;
		else {
			lines.push(current);
			current = word;
		}
	}
	lines.push(current);
	return lines;
}

function truncateToWidth(
	text: string,
	fontSize: number,
	maxWidth: number,
	measure: FitTextOptions['measure'],
): string {
	if (measure(fontSize, text) <= maxWidth) return text;
	const ellipsis = '…';
	let value = text;
	while (value.length > 0 && measure(fontSize, `${value}${ellipsis}`) > maxWidth) {
		value = value.slice(0, -1).trimEnd();
	}
	return value ? `${value}${ellipsis}` : ellipsis;
}

export function fitTextLines(text: string, options: FitTextOptions): FittedText {
	const lineHeightRatio = options.lineHeightRatio ?? 1.12;
	const maxFontSize = Math.max(options.minFontSize, Math.floor(options.maxFontSize));
	const requestedMinFontSize = Math.max(1, Math.floor(options.minFontSize));
	const minFontSize = options.maxHeight
		? Math.max(
				1,
				Math.min(
					requestedMinFontSize,
					Math.floor(options.maxHeight / Math.max(1, options.maxLines) / lineHeightRatio),
				),
			)
		: requestedMinFontSize;

	for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 1) {
		const lines = wrapWords(text, fontSize, options.maxWidth, options.measure);
		if (
			lines.length <= options.maxLines &&
			lines.length * fontSize * lineHeightRatio <= (options.maxHeight ?? Number.POSITIVE_INFINITY) &&
			lines.every((line) => options.measure(fontSize, line) <= options.maxWidth)
		) {
			return { fontSize, lineHeight: fontSize * lineHeightRatio, lines };
		}
	}

	const wrapped = wrapWords(text, minFontSize, options.maxWidth, options.measure);
	const lines = wrapped.slice(0, options.maxLines).map((line) =>
		truncateToWidth(line, minFontSize, options.maxWidth, options.measure),
	);
	if (wrapped.length > options.maxLines) {
		lines[options.maxLines - 1] = truncateToWidth(
			wrapped.slice(options.maxLines - 1).join(' '),
			minFontSize,
			options.maxWidth,
			options.measure,
		);
	} else {
		lines[lines.length - 1] = truncateToWidth(
			lines.at(-1) ?? '',
			minFontSize,
			options.maxWidth,
			options.measure,
		);
	}

	return { fontSize: minFontSize, lineHeight: minFontSize * lineHeightRatio, lines };
}

export function shareCardLayoutStyle(): string {
	const { height, header, headline, visual, metric, comparison, activity, footer } =
		DAILY_SHARE_CARD_LAYOUT;
	const percent = (value: number) => `${((value / height) * 100).toFixed(3)}%`;
	return [
		`--card-header-top:${percent(header.top)}`,
		`--card-header-bottom:${percent(header.bottom)}`,
		`--card-headline-top:${percent(headline.top)}`,
		`--card-headline-bottom:${percent(headline.bottom)}`,
		`--card-visual-top:${percent(visual.top)}`,
		`--card-visual-bottom:${percent(visual.bottom)}`,
		`--card-metric-top:${percent(metric.top)}`,
		`--card-metric-bottom:${percent(metric.bottom)}`,
		`--card-comparison-top:${percent(comparison.top)}`,
		`--card-comparison-bottom:${percent(comparison.bottom)}`,
		`--card-activity-top:${percent(activity.top)}`,
		`--card-activity-bottom:${percent(activity.bottom)}`,
		`--card-footer-top:${percent(footer.top)}`,
		`--card-footer-bottom:${percent(footer.bottom)}`,
	].join(';');
}
