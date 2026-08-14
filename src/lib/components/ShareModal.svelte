<script lang="ts">
  import { env } from '$env/dynamic/public';
  import { onMount } from 'svelte';
  import type { DayDetailResponse } from '$lib/types';
  import { dayLabel } from './chart';
  import { focusDialog, trapDialogTab } from './focus';
  import HistogramBackdrop from './HistogramBackdrop.svelte';
  import {
    buildShareCardData,
    getShareCaption,
    getShareMoodLine,
    getShareTagline,
    normalizeHistogram,
    safeShareProductLink,
    type ShareCardData,
    type SharePlatform,
    type ShareTone,
  } from './share';

  interface Props {
    open: boolean;
    detail: DayDetailResponse;
    isToday: boolean;
    refreshing: boolean;
    onclose: () => void;
  }

  let { open, detail, isToday, refreshing, onclose }: Props = $props();
  let tone = $state<ShareTone>('friendly');
  let status = $state<string | null>(null);
  let modal = $state<HTMLElement>();
  let previousOpen = false;
  let preparedFile = $state<File | null>(null);
  let preparing = $state(false);
  let nativeFileShareAvailable = $state(false);
  let clipboardImageAvailable = $state(false);
  let renderVersion = 0;

  let productLink = $derived(safeShareProductLink(env.PUBLIC_TOKENENVY_URL));
  let productAttribution = $derived(productLink?.label ?? 'Token Envy');
  let card = $derived(
    buildShareCardData({
      date: detail.date,
      median: detail.summary.median,
      count: detail.summary.count,
      sessions: detail.summary.sessions,
      outputTokens: detail.summary.outputTokens,
      isToday,
      speedIndex: detail.speedIndex,
      models: detail.models,
      histogram: detail.histogram,
    }),
  );
  let tagline = $derived(getShareTagline(tone, card));
  let moodLine = $derived(getShareMoodLine(card));
  let previewLabel = $derived(
    `Token Envy share card for ${dayLabel(card.date)}. ${tagline}. ${Math.round(card.median)} effective output tokens per second. ${moodLine}`,
  );
  let canExport = $derived(!refreshing && preparedFile !== null);

  onMount(() => {
    clipboardImageAvailable =
      typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
  });

  $effect(() => {
    if (open && !previousOpen) {
      tone = 'friendly';
      status = null;
    }
    previousOpen = open;
  });

  $effect(() => {
    if (!open || !modal) return;
    const dialog = modal;
    const previous = document.activeElement as HTMLElement | null;
    focusDialog(dialog);
    document.body.classList.add('overlay-open');
    return () => {
      document.body.classList.remove('overlay-open');
      previous?.focus?.();
    };
  });

  $effect(() => {
    const currentCard = card;
    const currentTagline = tagline;
    const currentMood = moodLine;
    const currentAttribution = productAttribution;
    if (!open) {
      renderVersion += 1;
      preparedFile = null;
      nativeFileShareAvailable = false;
      preparing = false;
      return;
    }
    void prepareCard(currentCard, currentTagline, currentMood, currentAttribution);
  });

  function trapFocus(event: KeyboardEvent) {
    if (!open || !modal) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
      return;
    }
    trapDialogTab(event, modal);
  }

  function setTone(next: ShareTone) {
    tone = next;
    status = null;
  }

  async function prepareCard(
    currentCard: ShareCardData,
    currentTagline: string,
    currentMood: string,
    currentAttribution: string,
  ) {
    const version = ++renderVersion;
    preparedFile = null;
    nativeFileShareAvailable = false;
    preparing = true;
    try {
      const blob = await renderCard(currentCard, currentTagline, currentMood, currentAttribution);
      if (version !== renderVersion) return;
      const file = new File([blob], `token-envy-${currentCard.date}.png`, { type: 'image/png' });
      preparedFile = file;
      nativeFileShareAvailable =
        typeof navigator.share === 'function' &&
        typeof navigator.canShare === 'function' &&
        navigator.canShare({ files: [file] });
    } catch {
      if (version === renderVersion) status = 'The image could not be prepared. Try again.';
    } finally {
      if (version === renderVersion) preparing = false;
    }
  }

  function renderCard(
    currentCard: ShareCardData,
    currentTagline: string,
    currentMood: string,
    currentAttribution: string,
  ): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 630;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');

    const background = context.createLinearGradient(0, 0, 1200, 630);
    background.addColorStop(0, '#07131c');
    background.addColorStop(0.58, '#102a2e');
    background.addColorStop(1, '#173f3a');
    context.fillStyle = background;
    context.fillRect(0, 0, 1200, 630);

    const glow = context.createRadialGradient(600, 335, 20, 600, 335, 440);
    glow.addColorStop(0, 'rgba(199, 255, 98, 0.18)');
    glow.addColorStop(1, 'rgba(199, 255, 98, 0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, 1200, 630);

    context.fillStyle = '#c7ff62';
    context.font = '700 25px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText('TOKEN ENVY', 70, 68);

    context.textAlign = 'right';
    context.fillStyle = 'rgba(238, 246, 239, 0.82)';
    context.font = '500 24px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(formatShareDate(currentCard.date), 1130, 68);

    context.textAlign = 'center';
    context.fillStyle = '#eef6ef';
    context.font = '650 42px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(currentTagline, 600, 140);

    const bars = normalizeHistogram(currentCard.histogram, currentCard.median);
    const chartX = 88;
    const chartY = 192;
    const chartWidth = 1024;
    const chartHeight = 220;
    const gap = bars.length > 24 ? 3 : 6;
    const barWidth = bars.length > 0 ? (chartWidth - gap * (bars.length - 1)) / bars.length : 0;
    for (const [index, bar] of bars.entries()) {
      const height = Math.max(8, chartHeight * bar.height);
      context.fillStyle = bar.containsMedian
        ? 'rgba(199, 255, 98, 0.72)'
        : 'rgba(119, 211, 180, 0.28)';
      context.fillRect(
        chartX + index * (barWidth + gap),
        chartY + chartHeight - height,
        barWidth,
        height,
      );
    }

    context.lineWidth = 14;
    context.strokeStyle = 'rgba(7, 19, 28, 0.8)';
    context.fillStyle = '#ffffff';
    context.font = '750 142px Inter, ui-sans-serif, system-ui, sans-serif';
    context.strokeText(`${Math.round(currentCard.median)}`, 600, 350);
    context.fillText(`${Math.round(currentCard.median)}`, 600, 350);
    context.fillStyle = 'rgba(238, 246, 239, 0.88)';
    context.font = '650 27px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText('EFFECTIVE OUTPUT TOKENS / SECOND', 600, 392);

    context.fillStyle = '#c7ff62';
    context.font = '650 26px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(currentMood, 600, 456);

    context.fillStyle = 'rgba(238, 246, 239, 0.68)';
    context.font = '500 21px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(
      `${currentCard.count.toLocaleString('en-US')} measured requests · ${currentCard.sessions.toLocaleString('en-US')} sessions`,
      600,
      494,
    );

    context.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(70, 536);
    context.lineTo(1130, 536);
    context.stroke();

    context.textAlign = 'left';
    context.fillStyle = 'rgba(238, 246, 239, 0.78)';
    context.font = '500 20px Inter, ui-sans-serif, system-ui, sans-serif';
    const leadingModels = currentCard.models
      .slice(0, 3)
      .map((model) => model.family)
      .join(' · ');
    context.fillText(leadingModels || 'All measured model families', 70, 582);

    context.textAlign = 'right';
    context.fillStyle = '#c7ff62';
    context.font = '650 20px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(currentAttribution, 1130, 582);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('PNG export failed'))),
        'image/png',
      );
    });
  }

  async function copyImage() {
    if (!preparedFile || !clipboardImageAvailable) return;
    status = null;
    try {
      const write = navigator.clipboard.write([
        new ClipboardItem({ 'image/png': preparedFile }),
      ]);
      await write;
      status = 'Image copied. Paste or attach it in your composer.';
    } catch {
      status = 'Image copy was blocked. Download the PNG instead.';
    }
  }

  function downloadImage() {
    if (!preparedFile) return;
    const url = URL.createObjectURL(preparedFile);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = preparedFile.name;
    anchor.click();
    URL.revokeObjectURL(url);
    status = 'PNG downloaded. Attach it in your composer.';
  }

  async function nativeShare() {
    if (!preparedFile || !nativeFileShareAvailable) return;
    status = null;
    try {
      const result = navigator.share({
        files: [preparedFile],
        title: 'My Token Envy daily speed card',
        text: getShareCaption(tone, card, 'generic', productLink?.href ?? null),
      });
      await result;
      status = 'Share sheet opened with the image attached.';
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        status = 'Sharing was blocked. Download the PNG instead.';
      }
    }
  }

  function openComposer(platform: 'x' | 'bluesky' | 'linkedin') {
    let url: string;
    if (platform === 'x') {
      const params = new URLSearchParams({ text: getShareCaption(tone, card, 'x', null) });
      if (productLink) params.set('url', productLink.href);
      url = `https://x.com/intent/tweet?${params.toString()}`;
    } else if (platform === 'bluesky') {
      const text = getShareCaption(tone, card, 'bluesky', productLink?.href ?? null);
      url = `https://bsky.app/intent/compose?text=${encodeURIComponent(text)}`;
    } else {
      url = 'https://www.linkedin.com/feed/';
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    status =
      platform === 'linkedin'
        ? 'LinkedIn opened. Attach your downloaded PNG and paste the copied caption.'
        : `${platform === 'x' ? 'X' : 'Bluesky'} opened with the caption. Attach your copied or downloaded PNG.`;
  }

  async function copyCaption(platform: SharePlatform = 'linkedin') {
    status = null;
    try {
      const write = navigator.clipboard.writeText(
        getShareCaption(
          tone,
          card,
          platform,
          platform === 'bluesky' ? (productLink?.href ?? null) : null,
        ),
      );
      await write;
      status = 'Caption copied.';
    } catch {
      status = 'Caption copy was blocked. Try again after granting clipboard access.';
    }
  }

  function formatShareDate(value: string) {
    return new Intl.DateTimeFormat(undefined, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${value}T12:00:00Z`));
  }
</script>

<svelte:window onkeydown={trapFocus} />

{#if open}
  <button class="scrim share-scrim" type="button" aria-label="Close share card" onclick={onclose}></button>
  <div
    class="share-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="share-title"
    tabindex="-1"
    bind:this={modal}
  >
      <header class="drawer-header">
        <div>
          <p class="eyebrow">Share a daily card</p>
          <h2 id="share-title">Make this day a little competitive</h2>
          <p>Only aggregate speed statistics shown in the preview leave this browser.</p>
        </div>
        <button class="icon-button" data-autofocus type="button" onclick={onclose} aria-label="Close share card">×</button>
      </header>

    <div class="share-body">
      <div class="tone-control" role="group" aria-label="Card tone">
        <button
          type="button"
          class:active={tone === 'friendly'}
          aria-pressed={tone === 'friendly'}
          onclick={() => setTone('friendly')}
        >Friendly</button>
        <button
          type="button"
          class:active={tone === 'spicy'}
          aria-pressed={tone === 'spicy'}
          onclick={() => setTone('spicy')}
        >Spicy</button>
      </div>

      <div class="share-preview" role="img" aria-label={previewLabel} aria-busy={refreshing}>
        <div class="share-preview-header">
          <strong>Token Envy</strong>
          <span>{formatShareDate(card.date)}</span>
        </div>
        <div class="share-preview-center">
          <HistogramBackdrop bins={card.histogram} median={card.median} />
          <p>{tagline}</p>
          <strong>{Math.round(card.median)}</strong>
          <span>effective output tokens / second</span>
          <em>{moodLine}</em>
        </div>
        <div class="share-preview-footer">
          <span>{card.count.toLocaleString('en-US')} measured requests · {card.sessions.toLocaleString('en-US')} sessions</span>
          <strong>{productAttribution}</strong>
        </div>
      </div>

      <div class="share-actions" aria-label="Prepare the image">
        {#if nativeFileShareAvailable}
          <button class="primary-button" type="button" onclick={nativeShare} disabled={!canExport}>Share image…</button>
        {/if}
        {#if clipboardImageAvailable}
          <button class="secondary-button" type="button" onclick={copyImage} disabled={!canExport}>
            Copy image
          </button>
        {/if}
        <button class="secondary-button" type="button" onclick={downloadImage} disabled={!canExport}>
          {preparing ? 'Preparing PNG…' : 'Download PNG'}
        </button>
      </div>

      <section class="composer-guide" aria-labelledby="composer-title">
        <div>
          <p class="eyebrow">Post it</p>
          <h3 id="composer-title">Prepare the image, then open a composer</h3>
          <p>X and Bluesky can prefill text, but browsers cannot attach this image for them.</p>
        </div>
        <div class="composer-buttons">
          <button class="secondary-button" type="button" onclick={() => openComposer('x')} disabled={refreshing}>Open X</button>
          <button class="secondary-button" type="button" onclick={() => openComposer('bluesky')} disabled={refreshing}>Open Bluesky</button>
        </div>
        <div class="linkedin-guide">
          <strong>LinkedIn</strong>
          <button class="text-button" type="button" onclick={downloadImage} disabled={!canExport}>1. Download PNG</button>
          <button class="text-button" type="button" onclick={() => copyCaption('linkedin')} disabled={refreshing}>2. Copy caption</button>
          <button class="text-button" type="button" onclick={() => openComposer('linkedin')} disabled={refreshing}>3. Open LinkedIn</button>
        </div>
      </section>

      <p class="privacy-note">
        No prompts, responses, project names, file paths, or session identifiers are included.
      </p>
      <p class="share-status" aria-live="polite">
        {refreshing ? 'Refreshing this day before sharing…' : (status ?? (preparing ? 'Preparing the daily PNG…' : ''))}
      </p>
    </div>
  </div>
{/if}
