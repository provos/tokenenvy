<script lang="ts">
  import type { DayDetailResponse } from '$lib/types';
  import { dayLabel, FAMILY_COLORS } from './chart';
  import { focusDialog, trapDialogTab } from './focus';
  import type { ShareRefusalCounts } from './share';

  interface Props {
    open: boolean;
    loading: boolean;
    detail: DayDetailResponse | null;
    refusals: ShareRefusalCounts;
    error?: string | null;
    onclose: () => void;
  }

  let { open, loading, detail, refusals, error = null, onclose }: Props = $props();
  let panel = $state<HTMLElement>();
  let histogramMax = $derived(Math.max(1, ...(detail?.histogram.map((bin) => bin.count) ?? [1])));
  let hourlyMax = $derived(Math.max(1, ...(detail?.hourly.map((hour) => hour.median ?? 0) ?? [1])));
  let totalExcluded = $derived(
    Object.values(detail?.exclusions ?? {}).reduce((total, count) => total + count, 0)
  );
  let refusalUnknown = $derived(
    Math.max(0, refusals.attempted - refusals.recovered - refusals.userVisible)
  );

  $effect(() => {
    if (open && panel) {
      const dialog = panel;
      const previous = document.activeElement as HTMLElement | null;
      focusDialog(dialog);
      document.body.classList.add('overlay-open');
      return () => {
        document.body.classList.remove('overlay-open');
        previous?.focus?.();
      };
    }
  });

  function onKeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') onclose();
    if (panel) trapDialogTab(event, panel);
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <button class="scrim" aria-label="Close day details" onclick={onclose}></button>
  <div class="drawer" id="daily-detail" bind:this={panel} role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabindex="-1">
    <header class="drawer-header">
      <div>
        <p class="eyebrow">Daily distribution</p>
        <h2 id="drawer-title">{detail ? dayLabel(detail.date, detail.timezone) : 'Loading day'}</h2>
      </div>
      <button class="icon-button" data-autofocus aria-label="Close day details" onclick={onclose}>×</button>
    </header>

    {#if loading}
      <div class="drawer-loading" aria-live="polite">
        <span class="loader"></span>
        <p>Building this day’s distribution…</p>
      </div>
    {:else if error}
      <div class="inline-error" role="alert">
        <strong>Couldn’t load this day</strong>
        <span>{error}</span>
      </div>
    {:else if detail}
      <div class="drawer-body">
        <section class="drawer-summary" aria-label="Day summary">
          <div>
            <span>Median speed</span>
            <strong>{detail.summary.median.toFixed(1)} <small>tok/s</small></strong>
          </div>
          <div>
            <span>Middle 50%</span>
            <strong>{detail.summary.q1.toFixed(1)}–{detail.summary.q3.toFixed(1)}</strong>
          </div>
          <div>
            <span>Requests</span>
            <strong>{detail.summary.count.toLocaleString()}</strong>
          </div>
          <div>
            <span>Sessions</span>
            <strong>{detail.summary.sessions.toLocaleString()}</strong>
          </div>
        </section>

        <section class="drawer-section drawer-refusal-section" aria-label="Refusals for this day">
          <div class="section-heading compact-heading">
            <div>
              <p class="eyebrow">This day</p>
              <h3>Classifier refusals</h3>
            </div>
            {#if refusals.recorded}<span class="recorded-pill">Explicit only</span>{/if}
          </div>
          {#if refusals.recorded}
            <div class="refusal-total"><strong>{refusals.attempted.toLocaleString()}</strong><span>attempted</span></div>
            <div class="refusal-grid">
              <span><i class="recovered"></i><strong>{refusals.recovered.toLocaleString()}</strong><small>recovered by fallback</small></span>
              <span><i class="visible"></i><strong>{refusals.userVisible.toLocaleString()}</strong><small>user-visible</small></span>
              <span><i class="unknown"></i><strong>{refusalUnknown.toLocaleString()}</strong><small>unknown outcome</small></span>
            </div>
            <p class="drawer-refusal-note">Explicit transcript signals only; these counts are a lower bound.</p>
          {:else}
            <p class="subtle-empty">This log format does not expose explicit classifier outcomes.</p>
          {/if}
        </section>

        <section class="drawer-section">
          <div class="section-heading compact-heading">
            <div>
              <p class="eyebrow">Shape of the day</p>
              <h3>Request distribution</h3>
            </div>
            <span>{detail.summary.count.toLocaleString()} measured</span>
          </div>
          {#if detail.histogram.length}
            <div class="histogram" aria-label="Histogram of effective output speed">
              {#each detail.histogram as bin}
                <div class="histogram-bin" style={`--bar-height:${(bin.count / histogramMax) * 100}%`}>
                  <span class="histogram-count">{bin.count}</span>
                  <span
                    class="histogram-bar"
                    style={bin.family ? `--bar-color:${FAMILY_COLORS[bin.family]}` : undefined}
                    title={`${bin.lower.toFixed(0)}–${bin.upper.toFixed(0)} tokens/s: ${bin.count} requests`}
                  ></span>
                  <span class="histogram-label">{bin.lower.toFixed(0)}</span>
                </div>
              {/each}
            </div>
            <p class="axis-foot">Effective output tokens/s · bin lower bounds</p>
          {:else}
            <p class="subtle-empty">No eligible requests to distribute.</p>
          {/if}
        </section>

        <section class="drawer-section">
          <div class="section-heading compact-heading">
            <div>
              <p class="eyebrow">Local time</p>
              <h3>Hourly rhythm</h3>
            </div>
          </div>
          <div class="hour-strip" aria-label="Median speed by hour">
            {#each detail.hourly as hour}
              <div class="hour-cell">
                <span
                  class:hour-empty={hour.median === null}
                  class="hour-swatch"
                  style={`--hour-opacity:${hour.median === null ? 0.06 : Math.max(0.16, (hour.median / hourlyMax) * 0.92)}`}
                  title={`${hour.hour}:00 — ${hour.median === null ? 'No data' : `${hour.median.toFixed(1)} tokens/s (${hour.count})`}`}
                ></span>
                {#if hour.hour % 6 === 0}<span>{String(hour.hour).padStart(2, '0')}</span>{/if}
              </div>
            {/each}
          </div>
        </section>

        <section class="drawer-section">
          <div class="section-heading compact-heading">
            <div>
              <p class="eyebrow">Model mix</p>
              <h3>Who did the work</h3>
            </div>
          </div>
          <div class="model-breakdown">
            {#each detail.models as model}
              <div class="model-row">
                <span class="model-dot" style={`--model-color:${FAMILY_COLORS[model.family]}`}></span>
                <strong>{model.family}</strong>
                <span>{model.median.toFixed(1)} tok/s</span>
                <span>{Math.round(model.share * 100)}%</span>
              </div>
            {/each}
          </div>
        </section>

        <section class="drawer-section quality-note">
          <div>
            <p class="eyebrow">Data quality</p>
            <h3>{totalExcluded ? `${totalExcluded.toLocaleString()} events excluded` : 'All observed events eligible'}</h3>
          </div>
          {#if totalExcluded}
            <ul>
              {#each Object.entries(detail.exclusions) as [reason, count]}
                <li><span>{reason.replaceAll('_', ' ')}</span><strong>{count.toLocaleString()}</strong></li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>
    {/if}
  </div>
{/if}
