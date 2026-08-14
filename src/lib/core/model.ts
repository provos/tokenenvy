import type { ModelFamily } from '../types';

/**
 * Collapse Claude's dated model identifiers and UI aliases into stable product
 * families. Keeping this intentionally small makes unknown future models
 * visible rather than silently attributing them to the wrong family.
 */
export function normalizeModelFamily(model: unknown): ModelFamily {
  if (typeof model !== 'string') return 'other';

  const normalized = model.trim().toLowerCase();
  if (/^(?:claude[-_ ])?.*opus(?:[-_ ].*)?$/.test(normalized) || normalized === 'opusplan') {
    return 'opus';
  }
  if (/^(?:claude[-_ ])?.*sonnet(?:[-_ ].*)?$/.test(normalized)) return 'sonnet';
  if (/^(?:claude[-_ ])?.*haiku(?:[-_ ].*)?$/.test(normalized)) return 'haiku';
  if (/^(?:claude[-_ ])?.*fable(?:[-_ ].*)?$/.test(normalized)) return 'fable';
  return 'other';
}

export const OUTPUT_SIZE_STRATA = [64, 256, 1_024] as const;

export function outputSizeStratum(outputTokens: number): number {
  if (outputTokens <= OUTPUT_SIZE_STRATA[0]) return 0;
  if (outputTokens <= OUTPUT_SIZE_STRATA[1]) return 1;
  if (outputTokens <= OUTPUT_SIZE_STRATA[2]) return 2;
  return 3;
}
