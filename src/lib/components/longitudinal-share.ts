import type { LongitudinalSummary, ModelFamily, RefusalCounts } from '$lib/types';
import { SECURITY_BLUEPRINTS_CAPTION } from './brand';
import { adjustSentimentForRefusals, selectedLongitudinalRefusalCounts } from './refusal-mood';
import {
  compactSocialNumber,
  getRefusalMoodAdjustmentLine,
  getShareSentimentTheme,
  fitSocialCaption,
  SHARE_PRIVACY_NOTE,
  SHARE_SOCIAL_BRAND,
  SHARE_SOCIAL_PRIVACY,
  type SharePlatform,
  type ShareSentiment,
  type ShareTone,
} from './share';

export const LONGITUDINAL_INSTALL_CTA = 'Chart yours · npx tokenenvy';
export const LONGITUDINAL_CHALLENGE = 'How wild is your Claude weather?';

const FRIENDLY_HEADLINES: Record<ShareSentiment, string> = {
  [-2]: 'My Claude weather went sideways',
  [-1]: 'My Claude weather ran hot and cold',
  [0]: 'My Claude weather kept shifting',
  [1]: 'My Claude weather stayed calm',
  [2]: 'My Claude weather stayed clear and calm',
};

const SPICY_HEADLINES: Record<ShareSentiment, string> = {
  [-2]: 'Anthropic gave me four seasons in one chart',
  [-1]: 'Anthropic kept moving the thermostat',
  [0]: 'Anthropic weather: check again in five minutes',
  [1]: 'Anthropic kept it weirdly calm',
  [2]: 'Anthropic finally found the thermostat',
};

export function longitudinalPerformanceSentiment(summary: LongitudinalSummary): ShareSentiment {
  let base: ShareSentiment = 0;
  if (summary.quality !== 'insufficient' && summary.variationPct !== null) {
    if (summary.variationPct > 30) base = -1;
    else if (summary.variationPct < 20) base = 1;
  }
  return base;
}

export function suggestedLongitudinalSentiment(summary: LongitudinalSummary): ShareSentiment {
  const base = longitudinalPerformanceSentiment(summary);
  return adjustSentimentForRefusals(base, selectedLongitudinalRefusalCounts(summary)).suggested;
}

export function longitudinalSentimentDescription(summary: LongitudinalSummary): string {
  const base = longitudinalPerformanceSentiment(summary);
  const adjustment = adjustSentimentForRefusals(base, selectedLongitudinalRefusalCounts(summary));
  const baseMood = getShareSentimentTheme(base).label;
  const basis =
    summary.quality === 'insufficient' || summary.variationPct === null
      ? 'Neutral for now. This view needs more comparable data.'
      : `Adjusted variation suggested ${baseMood}.`;
  const refusalAdjustment = getRefusalMoodAdjustmentLine(adjustment);
  return `${basis}${refusalAdjustment ? ` ${refusalAdjustment}` : ''} Pick the mood; the numbers stay put.`;
}

export function longitudinalHeadline(tone: ShareTone, sentiment: ShareSentiment): string {
  return tone === 'spicy' ? SPICY_HEADLINES[sentiment] : FRIENDLY_HEADLINES[sentiment];
}

export function longitudinalRangeLabel(days: LongitudinalSummary['days']): string {
  return days === 365 ? '1-year' : `${days}-day`;
}

export function longitudinalFamilyLabel(families: readonly ModelFamily[]): string {
  if (families.length === 5) return 'All models';
  return families.map((family) => family.charAt(0).toUpperCase() + family.slice(1)).join(' + ');
}

export function longitudinalMetricLabel(summary: LongitudinalSummary): string {
  return summary.variationPct === null
    ? 'measured output tokens · forecast needs more comparable data'
    : 'typical adjusted swing from trend';
}

export function longitudinalTrendLabel(summary: LongitudinalSummary): string {
  if (summary.trendPct === null || Math.abs(summary.trendPct) < 10) return 'No clear speed drift';
  const rounded = Math.round(summary.trendPct);
  return `Speed trended ${Math.abs(rounded)}% ${rounded > 0 ? 'higher' : 'lower'} across the measured span`;
}

function totalCounts(
  summary: LongitudinalSummary,
  key: 'selected' | 'unattributed',
): RefusalCounts {
  return summary.refusals.reduce(
    (total, day) => ({
      attempted: total.attempted + day[key].attempted,
      recovered: total.recovered + day[key].recovered,
      userVisible: total.userVisible + day[key].userVisible,
      unknown: total.unknown + day[key].unknown,
    }),
    { attempted: 0, recovered: 0, userVisible: 0, unknown: 0 },
  );
}

export function longitudinalRefusalLines(summary: LongitudinalSummary): string[] {
  if (!summary.refusalsRecorded) return ['Explicit refusal signals unavailable'];
  const selected = totalCounts(summary, 'selected');
  const unattributed = totalCounts(summary, 'unattributed');
  if (selected.attempted === 0 && unattributed.attempted === 0) {
    return ['No explicit refusal signals in this range'];
  }
  const lines: string[] = [];
  if (selected.attempted > 0) {
    const outcomes = [
      selected.recovered > 0 ? `${selected.recovered} recovered` : null,
      selected.userVisible > 0 ? `${selected.userVisible} user-visible` : null,
      selected.unknown > 0 ? `${selected.unknown} unresolved` : null,
    ].filter((outcome): outcome is string => outcome !== null);
    lines.push(
      `${selected.attempted} selected-model refusal ${selected.attempted === 1 ? 'signal' : 'signals'}${outcomes.length ? ` · ${outcomes.join(' · ')}` : ''}`,
    );
  }
  if (unattributed.attempted > 0) {
    lines.push(`+${unattributed.attempted} without a model match · explicit lower bound`);
  } else if (selected.attempted > 0) {
    lines.push('Explicit signals only · lower bound');
  }
  return lines;
}

export function longitudinalCaption(
  summary: LongitudinalSummary,
  tone: ShareTone,
  sentiment: ShareSentiment,
  productUrl: string | null,
  platform: SharePlatform = 'generic',
): string {
  const headline = longitudinalHeadline(tone, sentiment);
  const weather =
    summary.variationPct === null
      ? 'This view needs more comparable data to estimate a forecast.'
      : `Typical adjusted swing: ${Math.round(summary.variationPct)}%.`;
  const filters = `${longitudinalRangeLabel(summary.days)}, ${longitudinalFamilyLabel(summary.families)}`;
  const refusalLines = longitudinalRefusalLines(summary);
  const refusals = summary.refusalsRecorded
    ? refusalLines.join('. ')
    : 'Explicit refusal signals unavailable';
  const link = productUrl ? ` ${productUrl}` : '';

  if (platform === 'x' || platform === 'bluesky') {
    const selected = totalCounts(summary, 'selected');
    const unattributed = totalCounts(summary, 'unattributed');
    const compactRefusals = !summary.refusalsRecorded
      ? 'Refusal signals unavailable.'
      : selected.attempted === 0 && unattributed.attempted === 0
        ? 'No explicit refusal signals in range; lower bound.'
        : `${[
            selected.attempted > 0
              ? `${compactSocialNumber(selected.attempted)} selected refusals: ${[
                  selected.recovered > 0
                    ? `${compactSocialNumber(selected.recovered)} recovered`
                    : null,
                  selected.userVisible > 0
                    ? `${compactSocialNumber(selected.userVisible)} visible`
                    : null,
                  selected.unknown > 0
                    ? `${compactSocialNumber(selected.unknown)} unresolved`
                    : null,
                ]
                  .filter(Boolean)
                  .join('/')}`
              : null,
            unattributed.attempted > 0
              ? `+${compactSocialNumber(unattributed.attempted)} unmatched`
              : null,
          ]
            .filter(Boolean)
            .join('; ')}; lower bound.`;
    const trend =
      summary.trendPct === null || Math.abs(summary.trendPct) < 10
        ? ''
        : `; ${summary.trendPct > 0 ? '+' : '-'}${Math.abs(Math.round(summary.trendPct))}% drift`;
    const metric =
      summary.variationPct === null
        ? 'Forecast still forming.'
        : `${Math.round(summary.variationPct)}% swing${trend}.`;
    return fitSocialCaption(
      headline,
      [metric, compactRefusals, LONGITUDINAL_CHALLENGE, SHARE_SOCIAL_PRIVACY, SHARE_SOCIAL_BRAND],
      platform === 'bluesky' ? productUrl : null,
      platform === 'x' ? 250 : 300,
    );
  }

  return `${headline}. ${weather} ${longitudinalTrendLabel(summary)}. ${summary.observedDays} observed days (${filters}). ${refusals}. ${LONGITUDINAL_CHALLENGE} ${SHARE_PRIVACY_NOTE} #TokenEnvy. ${SECURITY_BLUEPRINTS_CAPTION}${link}`;
}

export function longitudinalImageFilename(
  summary: LongitudinalSummary,
  tone: ShareTone,
  sentiment: ShareSentiment,
): string {
  const mood = ['brutal', 'rough', 'neutral', 'good', 'glorious'][sentiment + 2];
  return `token-envy-weather-${summary.days}d-${tone}-${mood}.png`;
}
