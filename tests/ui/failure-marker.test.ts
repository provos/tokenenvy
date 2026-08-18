import { describe, expect, it } from 'vitest';
import type { DatedFailureCounts } from '../../src/lib/types';
import { failureDayLabel } from '../../src/lib/components/chart';

function day(overrides: Partial<DatedFailureCounts> = {}): DatedFailureCounts {
  return { date: '2026-08-18', attempted: 0, overloaded: 0, serverError: 0, ...overrides };
}

describe('failureDayLabel', () => {
  it('names both platform classes and separates them from model refusals', () => {
    expect(failureDayLabel(day({ attempted: 10, overloaded: 7, serverError: 3 }))).toBe(
      '10 API failures: 7 overloaded, 3 server faults. Calls that never completed; not model refusals.',
    );
  });

  it('keeps singular wording for a lone failure', () => {
    expect(failureDayLabel(day({ attempted: 1, overloaded: 0, serverError: 1 }))).toBe(
      '1 API failure: 0 overloaded, 1 server fault. Calls that never completed; not model refusals.',
    );
  });

  it('reads as an explicit zero on a quiet day', () => {
    expect(failureDayLabel(day())).toBe(
      'No API failures recorded. Calls that never completed; not model refusals.',
    );
  });

  it('never mentions a model family, because failures are always unattributed', () => {
    const label = failureDayLabel(day({ attempted: 4, overloaded: 4, serverError: 0 }));
    for (const family of ['opus', 'sonnet', 'fable', 'haiku', 'selected-model']) {
      expect(label).not.toContain(family);
    }
  });

  it('claims no status class, because only 529 overloads are measured', () => {
    const label = failureDayLabel(day({ attempted: 3, overloaded: 0, serverError: 3 }));
    for (const claim of ['5xx', '500', 'Anthropic-side', 'nothing your request caused']) {
      expect(label).not.toContain(claim);
    }
  });
});
