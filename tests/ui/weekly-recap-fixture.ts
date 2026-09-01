import type { WeeklyRecapData } from '../../src/lib/components/weekly-recap';

export const weeklyRecapFixture: WeeklyRecapData = {
  startDate: '2026-08-08',
  throughDate: '2026-08-14',
  daysObserved: 4,
  observedDates: ['2026-08-08', '2026-08-10', '2026-08-13', '2026-08-14'],
  requestCount: 84,
  sessions: 12,
  median: 72,
  speedIndex: {
    value: 108,
    ciLow: 102,
    ciHigh: 114,
    percentile: 93,
    eligible: true,
    reason: null,
  },
  models: [{ family: 'sonnet', requestCount: 60, outputTokens: 18_000, share: 0.72 }],
  fastestDay: { date: '2026-08-13', median: 91 },
  slowestDay: { date: '2026-08-10', median: 54 },
  refusals: {
    recorded: true,
    attempted: 0,
    recovered: 0,
    userVisible: 0,
    unknown: 0,
    affectedDates: [],
  },
  failures: {
    recorded: true,
    attempted: 0,
    overloaded: 0,
    serverError: 0,
    affectedDates: [],
  },
};
