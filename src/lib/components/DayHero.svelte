<script lang="ts">
  import type { DayDetailResponse, SpeedIndex } from '$lib/types';
  import { compactNumber, dayLabel } from './chart';
  import HistogramBackdrop from './HistogramBackdrop.svelte';
  import { speedIndexDelta } from './share';

  interface Props {
    date: string | null;
    today: string;
    detail: DayDetailResponse | null;
    loading: boolean;
    error: string | null;
    onretry: () => void;
    onmore: () => void;
  }

  let { date, today, detail, loading, error, onretry, onmore }: Props = $props();
  let label = $derived(date ? (date === today ? 'Today' : dayLabel(date)) : 'Selected day');
  let indexDelta = $derived(detail ? speedIndexDelta(detail.speedIndex) : null);
  let baselineCopy = $derived(detail ? describeBaseline(detail.speedIndex) : '');

  function describeBaseline(index: SpeedIndex): string {
    const delta = speedIndexDelta(index);
    if (delta === null) {
      return index.reason ? `Baseline warming up · ${index.reason}` : 'Baseline warming up';
    }
    if (delta === 0) return 'Right at your baseline';
    return `${delta > 0 ? '+' : ''}${delta}% vs your baseline`;
  }
</script>

<section class="hero-card day-hero" aria-busy={loading} aria-label={`${label} performance`}>
  {#if detail}
    <HistogramBackdrop bins={detail.histogram} median={detail.summary.median} />
    {#if loading}
      <span class="hero-refresh-status" role="status">Updating in the background…</span>
    {:else if error}
      <button class="hero-refresh-status hero-refresh-error" type="button" onclick={onretry}>
        Update delayed · Retry
      </button>
    {/if}
    <div class="hero-copy">
      <p class="eyebrow">{label} · effective output speed</p>
      <div class="hero-number-row">
        <strong>{Math.round(detail.summary.median)}</strong>
        <span>tokens/s</span>
      </div>
      <p class="hero-baseline" class:positive={indexDelta !== null && indexDelta > 0}>
        {baselineCopy}
      </p>
      <button
        class="secondary-button hero-more"
        type="button"
        onclick={onmore}
        aria-haspopup="dialog"
        aria-controls="daily-detail"
      >
        More info about {label.toLowerCase()}
      </button>
    </div>

    <div class="hero-stats" aria-label={`${label} activity summary`}>
      <div>
        <span>Measured requests</span>
        <strong>{detail.summary.count.toLocaleString('en-US')}</strong>
      </div>
      <div>
        <span>Sessions</span>
        <strong>{detail.summary.sessions.toLocaleString('en-US')}</strong>
      </div>
      <div>
        <span>Output tokens</span>
        <strong>{compactNumber(detail.summary.outputTokens)}</strong>
      </div>
    </div>
  {:else if loading}
    <div class="hero-loading" role="status">
      <p class="eyebrow">{label}</p>
      <p class="hero-loading-title">Loading this day…</p>
      <p>Rebuilding the daily distribution from local measurements.</p>
    </div>
  {:else if error}
    <div class="hero-loading hero-error" role="alert">
      <p class="eyebrow">{label}</p>
      <p class="hero-loading-title">Couldn’t load this day</p>
      <p>{error}</p>
      <button class="secondary-button" type="button" onclick={onretry}>Retry</button>
    </div>
  {:else}
    <div class="hero-loading">
      <p class="eyebrow">Selected day</p>
      <p class="hero-loading-title">Choose a day from the trend</p>
    </div>
  {/if}
</section>
