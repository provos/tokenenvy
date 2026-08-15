<script lang="ts">
  import DayHero from '../../../src/lib/components/DayHero.svelte';
  import { dashboardRefreshDate } from '../../../src/routes/+page.svelte';
  import type { DayDetailResponse } from '../../../src/lib/types';

  const today = '2026-08-14';
  const selectedDay = '2026-08-13';
  const retainedDetail: DayDetailResponse = {
    date: selectedDay,
    timezone: 'America/Los_Angeles',
    summary: {
      count: 12,
      sessions: 3,
      median: 64,
      q1: 50,
      q3: 75,
      p10: 42,
      p90: 90,
      ciLow: 58,
      ciHigh: 70,
      outputTokens: 4200,
    },
    speedIndex: {
      value: 108,
      ciLow: 102,
      ciHigh: 114,
      percentile: 70,
      eligible: true,
      reason: null,
    },
    models: [],
    histogram: [
      { lower: 40, upper: 60, count: 4 },
      { lower: 60, upper: 80, count: 8 },
    ],
    hourly: [],
    exclusions: {},
  };
  const refreshedDetail: DayDetailResponse = {
    ...retainedDetail,
    summary: { ...retainedDetail.summary, median: 65 },
  };
  const todayDetail: DayDetailResponse = {
    ...retainedDetail,
    date: today,
    summary: { ...retainedDetail.summary, median: 70 },
  };

  let availableDates = $state<string[]>([]);
  let selectedDate = $state<string | null>(null);
  let detail = $state<DayDetailResponse | null>(null);
  let loading = $state(false);

  function loadR0() {
    availableDates = [selectedDay, today];
    selectedDate = today;
    detail = todayDetail;
  }

  function loadInitialEmpty() {
    availableDates = [];
    selectedDate = dashboardRefreshDate(selectedDate, today, 0, availableDates, true);
    detail = null;
    loading = false;
  }

  function loadFirstData() {
    availableDates = [today];
    selectedDate = dashboardRefreshDate(
      selectedDate,
      today,
      6,
      availableDates,
      selectedDate === null,
    );
    detail = todayDetail;
    loading = false;
  }

  function selectExplicitDay() {
    if (!availableDates.includes(selectedDay)) return;
    selectedDate = selectedDay;
    detail = retainedDetail;
  }

  function applyRefresh(dates: string[], reconcileAvailability: boolean) {
    availableDates = dates;
    const target = dashboardRefreshDate(
      selectedDate,
      today,
      6,
      availableDates,
      reconcileAvailability,
    );
    if (target !== selectedDate) detail = null;
    selectedDate = target;
    loading = true;
  }

  function restoreSelectedDay() {
    applyRefresh([selectedDay, today], false);
    detail = refreshedDetail;
    loading = false;
  }
</script>

<button data-testid="load-r0" onclick={loadR0}>Load R0</button>
<button data-testid="load-empty" onclick={loadInitialEmpty}>Load empty</button>
<button data-testid="load-first-data" onclick={loadFirstData}>Load first data</button>
<button data-testid="select-aug13" onclick={selectExplicitDay}>Select Aug 13</button>
<button data-testid="refresh-r1" onclick={() => applyRefresh([today], false)}>Refresh R1</button>
<button data-testid="refresh-r2" onclick={restoreSelectedDay}>Refresh R2</button>
<button data-testid="range-change" onclick={() => applyRefresh([today], true)}>Range change</button>
<output data-testid="selected-date">{selectedDate}</output>
<DayHero
  date={selectedDate}
  {today}
  {detail}
  {loading}
  error={null}
  onretry={() => undefined}
  onmore={() => undefined}
/>
