<script lang="ts">
  import type { DailyPoint, ModelFamily } from '$lib/types';
  import { areaPath, chartMaximum, dayLabel, FAMILY_COLORS, linePath } from './chart';

  interface Props {
    points: DailyPoint[];
    timezone: string;
    visibleFamilies: ModelFamily[];
    selectedDate: string | null;
    onselect: (date: string) => void;
  }

  let { points, timezone, visibleFamilies, selectedDate, onselect }: Props = $props();
  const width = 820;
  const height = 286;
  const pad = { top: 24, right: 18, bottom: 42, left: 52 };
  let chart = $state<SVGSVGElement>();
  let keyboardDate = $state<string | null>(null);
  let dates = $derived([...new Set(points.map((point) => point.date))].sort());
  let filtered = $derived(points.filter((point) => visibleFamilies.includes(point.family)));
  let max = $derived(chartMaximum(filtered));
  let families = $derived(
    visibleFamilies.map((family) => ({
      family,
      points: filtered.filter((point) => point.family === family).sort((a, b) => a.date.localeCompare(b.date))
    }))
  );
  let gridValues = $derived([0, 0.25, 0.5, 0.75, 1].map((part) => max * part));
  let labelStep = $derived(Math.max(1, Math.ceil(dates.length / 7)));

  $effect(() => {
    if (dates.length === 0) {
      keyboardDate = null;
    } else if (selectedDate && dates.includes(selectedDate) && keyboardDate !== selectedDate) {
      keyboardDate = selectedDate;
    } else if (!keyboardDate || !dates.includes(keyboardDate)) {
      keyboardDate = dates.at(-1)!;
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
    const current = dates.indexOf(date);
    let target = current;
    if (event.key === 'ArrowLeft') target = Math.max(0, current - 1);
    else if (event.key === 'ArrowRight') target = Math.min(dates.length - 1, current + 1);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = dates.length - 1;
    else return;
    event.preventDefault();
    keyboardDate = dates[target];
    requestAnimationFrame(() => chart?.querySelector<SVGRectElement>(`[data-date="${keyboardDate}"]`)?.focus());
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
      Median effective output tokens per second. Shaded regions show the middle 50 percent of requests.
      Select any day to update the daily summary. Use Left and Right Arrow to move between days.
    </desc>
    <g transform={`translate(${pad.left} ${pad.top})`}>
      {#each gridValues as value}
        {@const y = height - (value / max) * height}
        <line class="grid-line" x1="0" x2={width} y1={y} y2={y} />
        <text class="axis-label axis-label-y" x="-12" y={y + 4} text-anchor="end">{Math.round(value)}</text>
      {/each}

      {#each families as series}
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
          {#each series.points as point}
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
              <title>{series.family}: {point.median.toFixed(1)} tokens/s on {dayLabel(point.date, timezone)}</title>
            </circle>
          {/each}
        {/if}
      {/each}

      {#each dates as date, index}
        {@const x = xFor(date)}
        <rect
          class="day-target"
          class:selected={selectedDate === date}
          x={Math.max(0, x - Math.max(5, width / Math.max(1, dates.length) / 2))}
          y="0"
          width={Math.max(10, width / Math.max(1, dates.length))}
          height={height}
          data-date={date}
          tabindex={keyboardDate === date ? 0 : -1}
          role="button"
          aria-pressed={selectedDate === date}
          aria-label={`Select ${dayLabel(date, timezone)} for the daily summary`}
          onclick={() => {
            keyboardDate = date;
            onselect(date);
          }}
          onkeydown={(event) => selectFromKey(event, date)}
        />
        {#if index % labelStep === 0 || index === dates.length - 1}
          <text class="axis-label" x={x} y={height + 27} text-anchor="middle">{dayLabel(date, timezone)}</text>
        {/if}
      {/each}
      <text class="axis-title" transform={`translate(-40 ${height / 2}) rotate(-90)`} text-anchor="middle">
        Effective output tokens/s
      </text>
    </g>
  </svg>
</div>

<details class="table-alternative">
  <summary>View as accessible table</summary>
  <div class="table-scroll">
    <table>
      <thead>
        <tr><th>Date</th><th>Model</th><th>Median</th><th>Middle 50%</th><th>Requests</th></tr>
      </thead>
      <tbody>
        {#each [...filtered].sort((a, b) => b.date.localeCompare(a.date) || a.family.localeCompare(b.family)) as point}
          <tr>
            <th scope="row"><button class="table-date" aria-pressed={selectedDate === point.date} onclick={() => onselect(point.date)}>{dayLabel(point.date, timezone)}</button></th>
            <td><span class="model-dot" style={`--model-color:${FAMILY_COLORS[point.family]}`}></span>{point.family}</td>
            <td>{point.median.toFixed(1)}</td>
            <td>{point.q1.toFixed(1)}–{point.q3.toFixed(1)}</td>
            <td>{point.count.toLocaleString()}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</details>
