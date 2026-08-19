<script lang="ts">
  import type {
    DailyPoint,
    DatedFailureCounts,
    LongitudinalRefusalDay,
    ModelFamily,
  } from '$lib/types';
  import {
    areaPath,
    chartMaximum,
    chartTickIndices,
    chartTickLabel,
    dayLabel,
    failureDayLabel,
    FAMILY_COLORS,
    linePath,
    refusalDayLabel,
  } from './chart';

  interface Props {
    points: DailyPoint[];
    timezone: string;
    today: string;
    visibleFamilies: ModelFamily[];
    refusals?: LongitudinalRefusalDay[];
    /**
     * Platform failures are always unattributed, so they are intentionally not
     * filtered by `visibleFamilies` — hiding them behind a family chip would
     * remove the evidence exactly when someone is investigating a slowdown.
     */
    failures?: DatedFailureCounts[];
    selectedDate: string | null;
    onselect: (date: string) => void;
  }

  let {
    points,
    timezone,
    today,
    visibleFamilies,
    refusals = [],
    failures = [],
    selectedDate,
    onselect,
  }: Props = $props();
  const width = 820;
  const height = 286;
  let chart = $state<SVGSVGElement>();
  let keyboardDate = $state<string | null>(null);
  // The failure row sits above the refusal row, so it needs its own headroom.
  let pad = $derived({
    top: failures.length ? 58 : 40,
    right: 18,
    bottom: 54,
    left: 52,
  });
  let measuredDates = $derived([...new Set(points.map((point) => point.date))].sort());
  let dates = $derived(
    [
      ...new Set([
        ...measuredDates,
        ...refusals.map((refusal) => refusal.date),
        ...failures.map((failure) => failure.date),
      ]),
    ].sort(),
  );
  let refusalsByDate = $derived(
    new Map(refusals.map((refusal) => [refusal.date, refusal] as const)),
  );
  let failuresByDate = $derived(
    new Map(failures.map((failure) => [failure.date, failure] as const)),
  );
  let filtered = $derived(points.filter((point) => visibleFamilies.includes(point.family)));
  let max = $derived(chartMaximum(filtered));
  let families = $derived(
    visibleFamilies.map((family) => ({
      family,
      points: filtered
        .filter((point) => point.family === family)
        .sort((a, b) => a.date.localeCompare(b.date)),
    })),
  );
  let gridValues = $derived([0, 0.25, 0.5, 0.75, 1].map((part) => max * part));
  let tickIndices = $derived(chartTickIndices(dates.length));

  $effect(() => {
    if (measuredDates.length === 0) {
      keyboardDate = null;
    } else if (
      selectedDate &&
      measuredDates.includes(selectedDate) &&
      keyboardDate !== selectedDate
    ) {
      keyboardDate = selectedDate;
    } else if (!keyboardDate || !measuredDates.includes(keyboardDate)) {
      keyboardDate = measuredDates.at(-1)!;
    }
  });

  function xFor(date: string): number {
    return dates.length <= 1 ? width / 2 : (dates.indexOf(date) / (dates.length - 1)) * width;
  }

  function selectFromKey(event: KeyboardEvent, date: string) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onselect(date);
      return;
    }
    const current = measuredDates.indexOf(date);
    let target: number;
    if (event.key === 'ArrowLeft') target = Math.max(0, current - 1);
    else if (event.key === 'ArrowRight') target = Math.min(measuredDates.length - 1, current + 1);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = measuredDates.length - 1;
    else return;
    event.preventDefault();
    keyboardDate = measuredDates[target];
    requestAnimationFrame(() =>
      chart?.querySelector<SVGRectElement>(`[data-date="${keyboardDate}"]`)?.focus(),
    );
  }

  function refusalFor(date: string): LongitudinalRefusalDay | undefined {
    return refusalsByDate.get(date);
  }

  function failureFor(date: string): DatedFailureCounts | undefined {
    return failuresByDate.get(date);
  }
</script>

<div class="chart-shell">
  <svg
    bind:this={chart}
    class="trend-chart"
    viewBox={`0 0 ${width + pad.left + pad.right} ${height + pad.top + pad.bottom}`}
    role="group"
    aria-roledescription="interactive chart"
    aria-labelledby="trend-title trend-desc"
  >
    <title id="trend-title">Daily effective output speed by model family</title>
    <desc id="trend-desc">
      Median effective output tokens per second. Shaded regions show the middle 50 percent of
      requests. Select any day to update the daily summary. Use Left and Right Arrow to move between
      days.
    </desc>
    <g transform={`translate(${pad.left} ${pad.top})`}>
      {#each failures as failure (failure.date)}
        {#if failure.attempted > 0}
          {@const x = xFor(failure.date)}
          {@const markerX = Math.max(8, Math.min(width - 8, x))}
          <g
            class="failure-marker"
            class:server-fault={failure.serverError > 0}
            transform={`translate(${markerX} -36)`}
            aria-hidden="true"
          >
            <circle cx="0" cy="0" r="6.5" />
            <line x1="-3" y1="-3" x2="3" y2="3" />
            <line x1="-3" y1="3" x2="3" y2="-3" />
          </g>
        {/if}
      {/each}
      {#each refusals as refusal (refusal.date)}
        {@const x = xFor(refusal.date)}
        {@const selectedVisible = refusal.selected.userVisible > 0}
        {@const selectedAttempt = refusal.selected.attempted > 0}
        {@const unattributedAttempt = refusal.unattributed.attempted > 0}
        {@const markerInset = selectedAttempt && unattributedAttempt ? 13 : 7}
        {@const markerX = Math.max(markerInset, Math.min(width - markerInset, x))}
        {#if selectedAttempt}
          <g
            class="refusal-marker"
            class:user-visible={selectedVisible}
            class:recovered={!selectedVisible}
            transform={`translate(${markerX + (unattributedAttempt ? -5 : 0)} -18)`}
            aria-hidden="true"
          >
            <path d="M 0 -7 L 7 6 L -7 6 Z" />
            <line x1="0" x2="0" y1="-3" y2="2" />
            <circle cx="0" cy="4" r="0.8" />
          </g>
        {/if}
        {#if unattributedAttempt}
          <g
            class="refusal-marker unattributed"
            transform={`translate(${markerX + (selectedAttempt ? 5 : 0)} -18)`}
            aria-hidden="true"
          >
            <path d="M 0 -7 L 7 6 L -7 6 Z" />
            <line x1="0" x2="0" y1="-3" y2="2" />
            <circle cx="0" cy="4" r="0.8" />
          </g>
        {/if}
      {/each}
      {#each gridValues as value (value)}
        {@const y = height - (value / max) * height}
        <line class="grid-line" x1="0" x2={width} y1={y} y2={y} />
        <text class="axis-label axis-label-y" x="-12" y={y + 4} text-anchor="end"
          >{Math.round(value)}</text
        >
      {/each}

      {#each families as series (series.family)}
        {#if series.points.length}
          <path
            class="iqr-area"
            d={areaPath(series.points, dates, max, width, height)}
            fill={FAMILY_COLORS[series.family]}
          />
          <path
            class="median-line"
            d={linePath(series.points, dates, max, width, height)}
            stroke={FAMILY_COLORS[series.family]}
          />
          {#each series.points as point (point.date)}
            {#if point.ciLow !== null && point.ciHigh !== null}
              <line
                class="ci-whisker"
                x1={xFor(point.date)}
                x2={xFor(point.date)}
                y1={height - (point.ciHigh / max) * height}
                y2={height - (point.ciLow / max) * height}
                stroke={FAMILY_COLORS[series.family]}
              />
              <line
                class="ci-whisker"
                x1={xFor(point.date) - 3}
                x2={xFor(point.date) + 3}
                y1={height - (point.ciHigh / max) * height}
                y2={height - (point.ciHigh / max) * height}
                stroke={FAMILY_COLORS[series.family]}
              />
              <line
                class="ci-whisker"
                x1={xFor(point.date) - 3}
                x2={xFor(point.date) + 3}
                y1={height - (point.ciLow / max) * height}
                y2={height - (point.ciLow / max) * height}
                stroke={FAMILY_COLORS[series.family]}
              />
            {/if}
            <circle
              class="chart-point"
              class:selected={selectedDate === point.date}
              cx={xFor(point.date)}
              cy={height - (point.median / max) * height}
              r={selectedDate === point.date ? 5 : 3.5}
              fill={FAMILY_COLORS[series.family]}
            >
              <title
                >{series.family}: {point.median.toFixed(1)} tokens/s on {dayLabel(
                  point.date,
                  timezone,
                )}</title
              >
            </circle>
          {/each}
        {/if}
      {/each}

      {#each dates as date, index (date)}
        {@const x = xFor(date)}
        {@const tickLabel = chartTickLabel(date, today, timezone)}
        {@const refusal = refusalFor(date)}
        {@const failure = failureFor(date)}
        {#if measuredDates.includes(date)}
          <rect
            class="day-target"
            class:selected={selectedDate === date}
            x={Math.max(0, x - Math.max(5, width / Math.max(1, measuredDates.length) / 2))}
            y="0"
            width={Math.max(10, width / Math.max(1, measuredDates.length))}
            {height}
            data-date={date}
            tabindex={keyboardDate === date ? 0 : -1}
            role="button"
            aria-pressed={selectedDate === date}
            aria-label={`Select ${tickLabel.accessible} for the daily summary${refusal ? `. ${refusalDayLabel(refusal)}` : ''}${failure && failure.attempted > 0 ? `. ${failureDayLabel(failure)}` : ''}`}
            onclick={() => {
              keyboardDate = date;
              onselect(date);
            }}
            onkeydown={(event) => selectFromKey(event, date)}
          />
        {/if}
        {#if tickIndices.includes(index)}
          <text
            class="axis-label"
            class:axis-label-today={date === today}
            {x}
            y={height + 27}
            text-anchor={index === 0 ? 'start' : index === dates.length - 1 ? 'end' : 'middle'}
            aria-hidden="true"
          >
            {#if tickLabel.secondary}
              <tspan class="today-tick" {x}>{tickLabel.primary}</tspan>
              <tspan {x} dy="12">{tickLabel.secondary}</tspan>
            {:else}
              {tickLabel.primary}
            {/if}
          </text>
        {/if}
      {/each}
      <text
        class="axis-title"
        transform={`translate(-40 ${height / 2}) rotate(-90)`}
        text-anchor="middle"
      >
        Effective output tokens/s
      </text>
    </g>
  </svg>
</div>

{#if refusals.length}
  <div class="chart-refusal-legend">
    <span class="refusal-legend-marker" aria-hidden="true">▲</span>
    <span>Explicit classifier refusal signals by day</span>
    {#if refusals.some((day) => day.unattributed.attempted > 0)}
      <small>Gray outline means the model family was unavailable.</small>
    {/if}
  </div>
  <ul class="sr-only" aria-label="Explicit classifier refusal signals by day">
    {#each refusals as refusal (refusal.date)}
      <li>{dayLabel(refusal.date, timezone)}: {refusalDayLabel(refusal)}</li>
    {/each}
  </ul>
{/if}

{#if failures.length}
  <div class="chart-failure-legend">
    <span class="failure-legend-marker" aria-hidden="true">⊗</span>
    <span>API failures by day — the service could not, whatever the model</span>
    {#if failures.some((day) => day.serverError > 0)}
      <small>A filled mark includes a server fault.</small>
    {/if}
  </div>
  <ul class="sr-only" aria-label="API failures by day">
    {#each failures as failure (failure.date)}
      <li>{dayLabel(failure.date, timezone)}: {failureDayLabel(failure)}</li>
    {/each}
  </ul>
{/if}

<details class="table-alternative">
  <summary>View as accessible table</summary>
  <div class="table-scroll">
    <table>
      <thead>
        <tr
          ><th>Date</th><th>Model</th><th>Median</th><th>Middle 50%</th><th>Requests</th><th
            >Refusals</th
          ><th>Failures</th></tr
        >
      </thead>
      <tbody>
        {#each [...filtered].sort((a, b) => b.date.localeCompare(a.date) || a.family.localeCompare(b.family)) as point (`${point.date}:${point.family}`)}
          <tr>
            <th scope="row"
              ><button
                class="table-date"
                aria-pressed={selectedDate === point.date}
                onclick={() => onselect(point.date)}>{dayLabel(point.date, timezone)}</button
              ></th
            >
            <td
              ><span class="model-dot" style={`--model-color:${FAMILY_COLORS[point.family]}`}
              ></span>{point.family}</td
            >
            <td>{point.median.toFixed(1)}</td>
            <td>{point.q1.toFixed(1)}–{point.q3.toFixed(1)}</td>
            <td>{point.count.toLocaleString()}</td>
            <td
              >{refusalFor(point.date)
                ? refusalDayLabel(refusalFor(point.date)!)
                : 'No explicit signal recorded'}</td
            >
            <td
              >{failureFor(point.date)
                ? failureDayLabel(failureFor(point.date)!)
                : 'No API failure recorded'}</td
            >
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</details>
