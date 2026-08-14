<script lang="ts">
  import { env } from '$env/dynamic/public';
  import { onMount } from 'svelte';
  import type { DayDetailResponse } from '$lib/types';
  import { SECURITY_BLUEPRINTS_CARD_LINE } from './brand';
  import { dayLabel } from './chart';
  import { focusDialog, trapDialogTab } from './focus';
  import HistogramBackdrop from './HistogramBackdrop.svelte';
  import {
    buildShareCardData,
    DEFAULT_SHARE_PRODUCT_URL,
    getShareCaption,
    getShareMoodLine,
    getShareRefusalLine,
    getShareSentimentTheme,
    getShareTagline,
    normalizeHistogram,
    normalizeShareSentiment,
    safeShareProductLink,
    sentimentAfterCardChange,
    SHARE_INSTALL_CTA,
    suggestedShareSentiment,
    type ShareCardData,
    type SharePlatform,
    type ShareSentiment,
    type ShareSentimentTheme,
    type ShareRefusalCounts,
    type ShareTone,
  } from './share';

  interface Props {
    open: boolean;
    detail: DayDetailResponse;
    refusals: ShareRefusalCounts;
    isToday: boolean;
    refreshing: boolean;
    onclose: () => void;
  }

  let { open, detail, refusals, isToday, refreshing, onclose }: Props = $props();
  let tone = $state<ShareTone>('friendly');
  let sentiment = $state<ShareSentiment>(0);
  let status = $state<string | null>(null);
  let modal = $state<HTMLElement>();
  let previousOpen = false;
  let sentimentCardDate: string | null = null;
  let preparedFile = $state<File | null>(null);
  let preparing = $state(false);
  let nativeFileShareAvailable = $state(false);
  let clipboardImageAvailable = $state(false);
  let renderVersion = 0;

  let productLink = $derived(
    safeShareProductLink(env.PUBLIC_TOKENENVY_URL ?? DEFAULT_SHARE_PRODUCT_URL),
  );
  let card = $derived(
    buildShareCardData({
      date: detail.date,
      median: detail.summary.median,
      count: detail.summary.count,
      sessions: detail.summary.sessions,
      outputTokens: detail.summary.outputTokens,
      isToday,
      speedIndex: detail.speedIndex,
      refusals,
      models: detail.models,
      histogram: detail.histogram,
    }),
  );
  let sentimentTheme = $derived(getShareSentimentTheme(sentiment));
  let tagline = $derived(getShareTagline(tone, sentiment, card));
  let moodLine = $derived(getShareMoodLine(card));
  let refusalLine = $derived(getShareRefusalLine(card));
  let previewLabel = $derived(
    `Token Envy share card for ${dayLabel(card.date)}. ${SECURITY_BLUEPRINTS_CARD_LINE}. ${sentimentTheme.accessibleLabel} mood. ${tagline}. ${Math.round(card.median)} effective output tokens per second. ${moodLine}. ${refusalLine}. ${SHARE_INSTALL_CTA}.`,
  );
  let previewStyle = $derived(
    `--share-bg-start:${sentimentTheme.backgroundStart};--share-bg-middle:${sentimentTheme.backgroundMiddle};--share-bg-end:${sentimentTheme.backgroundEnd};--share-accent:${sentimentTheme.accent};--share-secondary:${sentimentTheme.secondary};--share-text:${sentimentTheme.text};--share-muted:${sentimentTheme.mutedText};--share-glow:${sentimentTheme.glow};--share-bars:${sentimentTheme.bar};--share-median:${sentimentTheme.medianBar}`,
  );
  let canExport = $derived(!refreshing && preparedFile !== null);

  onMount(() => {
    clipboardImageAvailable =
      typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
  });

  $effect(() => {
    const nextCardDate = card.date;
    const suggestedSentiment = suggestedShareSentiment(card);
    if (open && !previousOpen) {
      tone = 'friendly';
      sentiment = suggestedSentiment;
      sentimentCardDate = nextCardDate;
      status = null;
    } else if (open && sentimentCardDate !== nextCardDate) {
      sentiment = sentimentAfterCardChange(
        sentimentCardDate,
        nextCardDate,
        sentiment,
        suggestedSentiment,
      );
      sentimentCardDate = nextCardDate;
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
    const currentRefusals = refusalLine;
    const currentSentiment = sentiment;
    const currentTheme = sentimentTheme;
    if (!open) {
      renderVersion += 1;
      preparedFile = null;
      nativeFileShareAvailable = false;
      preparing = false;
      return;
    }
    void prepareCard(
      currentCard,
      currentTagline,
      currentMood,
      currentRefusals,
      currentSentiment,
      currentTheme,
    );
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

  function setSentiment(next: number) {
    sentiment = normalizeShareSentiment(next);
    status = null;
  }

  async function prepareCard(
    currentCard: ShareCardData,
    currentTagline: string,
    currentMood: string,
    currentRefusals: string,
    currentSentiment: ShareSentiment,
    currentTheme: ShareSentimentTheme,
  ) {
    const version = ++renderVersion;
    preparedFile = null;
    nativeFileShareAvailable = false;
    preparing = true;
    try {
      const blob = await renderCard(
        currentCard,
        currentTagline,
        currentMood,
        currentRefusals,
        currentSentiment,
        currentTheme,
      );
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
    currentRefusals: string,
    currentSentiment: ShareSentiment,
    currentTheme: ShareSentimentTheme,
  ): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 630;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');

    const background = context.createLinearGradient(0, 0, 1200, 630);
    background.addColorStop(0, currentTheme.backgroundStart);
    background.addColorStop(0.58, currentTheme.backgroundMiddle);
    background.addColorStop(1, currentTheme.backgroundEnd);
    context.fillStyle = background;
    context.fillRect(0, 0, 1200, 630);

    const glow = context.createRadialGradient(600, 335, 20, 600, 335, 440);
    glow.addColorStop(0, currentTheme.glow);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, 1200, 630);

    drawSentimentFace(context, currentSentiment, currentTheme);

    context.fillStyle = currentTheme.accent;
    context.font = '700 25px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText('TOKEN ENVY', 70, 68);

    context.fillStyle = currentTheme.mutedText;
    context.font = '500 15px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText(SECURITY_BLUEPRINTS_CARD_LINE, 70, 94);

    context.textAlign = 'right';
    context.fillStyle = currentTheme.mutedText;
    context.font = '500 24px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(formatShareDate(currentCard.date), 1130, 68);

    context.textAlign = 'center';
    context.fillStyle = currentTheme.text;
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
        ? currentTheme.medianBar
        : currentTheme.bar;
      context.fillRect(
        chartX + index * (barWidth + gap),
        chartY + chartHeight - height,
        barWidth,
        height,
      );
    }

    context.lineWidth = 14;
    context.strokeStyle = currentTheme.outline;
    context.fillStyle = currentTheme.text;
    context.font = '750 142px Inter, ui-sans-serif, system-ui, sans-serif';
    context.strokeText(`${Math.round(currentCard.median)}`, 600, 350);
    context.fillText(`${Math.round(currentCard.median)}`, 600, 350);
    context.fillStyle = currentTheme.mutedText;
    context.font = '650 27px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText('EFFECTIVE OUTPUT TOKENS / SECOND', 600, 392);

    context.fillStyle = currentTheme.accent;
    context.font = '650 26px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(currentMood, 600, 456);

    context.fillStyle = currentTheme.mutedText;
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
    context.fillStyle = currentTheme.mutedText;
    context.font = '500 20px Inter, ui-sans-serif, system-ui, sans-serif';
    const leadingModels = currentCard.models
      .slice(0, 3)
      .map((model) => model.family)
      .join(' · ');
    context.fillText(leadingModels || 'All measured model families', 70, 582);

    context.textAlign = 'right';
    context.fillStyle = currentTheme.accent;
    context.font = '650 20px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(SHARE_INSTALL_CTA, 1130, 582);

    context.textAlign = 'center';
    context.fillStyle = currentTheme.accent;
    context.font = '600 17px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(currentRefusals, 600, 610);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('PNG export failed'))),
        'image/png',
      );
    });
  }

  function drawStar(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    outerRadius: number,
    innerRadius = outerRadius * 0.34,
  ) {
    context.beginPath();
    for (let point = 0; point < 8; point += 1) {
      const radius = point % 2 === 0 ? outerRadius : innerRadius;
      const angle = -Math.PI / 2 + point * Math.PI / 4;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (point === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    }
    context.closePath();
    context.fill();
  }

  function drawCross(context: CanvasRenderingContext2D, x: number, y: number, radius: number) {
    context.beginPath();
    context.moveTo(x - radius, y - radius);
    context.lineTo(x + radius, y + radius);
    context.moveTo(x + radius, y - radius);
    context.lineTo(x - radius, y + radius);
    context.stroke();
  }

  function drawSentimentFace(
    context: CanvasRenderingContext2D,
    currentSentiment: ShareSentiment,
    currentTheme: ShareSentimentTheme,
  ) {
    context.save();
    context.globalAlpha = 0.13;
    context.strokeStyle = currentTheme.accent;
    context.fillStyle = currentTheme.secondary;
    context.lineWidth = 14;
    context.lineCap = 'round';
    context.lineJoin = 'round';

    context.beginPath();
    context.arc(600, 306, 196, 0, Math.PI * 2);
    context.stroke();

    const eyeY = 258;
    if (currentSentiment === -2) {
      drawCross(context, 535, eyeY, 25);
      drawCross(context, 665, eyeY, 25);
    } else if (currentSentiment === -1) {
      context.beginPath();
      context.moveTo(510, eyeY + 13);
      context.lineTo(560, eyeY - 12);
      context.moveTo(640, eyeY - 12);
      context.lineTo(690, eyeY + 13);
      context.stroke();
    } else if (currentSentiment === 0) {
      context.beginPath();
      context.moveTo(512, eyeY);
      context.lineTo(558, eyeY);
      context.moveTo(642, eyeY);
      context.lineTo(688, eyeY);
      context.stroke();
    } else if (currentSentiment === 1) {
      context.beginPath();
      context.arc(535, eyeY, 13, 0, Math.PI * 2);
      context.arc(665, eyeY, 13, 0, Math.PI * 2);
      context.fill();
    } else {
      drawStar(context, 535, eyeY, 34);
      drawStar(context, 665, eyeY, 34);
      drawStar(context, 844, 200, 24);
      drawStar(context, 382, 390, 17);
    }

    context.beginPath();
    context.moveTo(520, 354);
    if (currentSentiment === 0) context.lineTo(680, 354);
    else context.quadraticCurveTo(600, 354 + currentSentiment * 40, 680, 354);
    context.stroke();

    if (currentSentiment === -2) {
      context.strokeStyle = currentTheme.secondary;
      context.lineWidth = 12;
      context.beginPath();
      context.moveTo(550, 393);
      context.quadraticCurveTo(575, 376, 600, 393);
      context.quadraticCurveTo(625, 410, 650, 393);
      context.stroke();
      context.beginPath();
      context.moveTo(570, 408);
      context.lineTo(570, 436);
      context.moveTo(622, 410);
      context.lineTo(622, 448);
      context.stroke();
    }

    context.restore();
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
        text: getShareCaption(tone, sentiment, card, 'generic', productLink?.href ?? null),
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
      const params = new URLSearchParams({ text: getShareCaption(tone, sentiment, card, 'x', null) });
      if (productLink) params.set('url', productLink.href);
      url = `https://x.com/intent/tweet?${params.toString()}`;
    } else if (platform === 'bluesky') {
      const text = getShareCaption(tone, sentiment, card, 'bluesky', productLink?.href ?? null);
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
          sentiment,
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
      <div class="share-controls">
        <div class="voice-control">
          <span class="share-control-label">Voice</span>
          <div class="tone-control" role="group" aria-label="Card voice">
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
        </div>
        <div class="sentiment-control" style={`--sentiment-accent:${sentimentTheme.accent}`}>
          <div class="sentiment-heading">
            <label for="share-sentiment">Card mood</label>
            <strong>{sentimentTheme.label}</strong>
          </div>
          <input
            id="share-sentiment"
            type="range"
            min="-2"
            max="2"
            step="1"
            value={sentiment}
            aria-valuetext={sentimentTheme.accessibleLabel}
            aria-describedby="sentiment-description"
            oninput={(event) => setSentiment(Number(event.currentTarget.value))}
          />
          <div class="sentiment-labels" aria-hidden="true">
            <span>Negative</span><span>Neutral</span><span>Positive</span>
          </div>
          <p id="sentiment-description">
            Starts from your adjusted comparable-day result. Move it anywhere; it changes the attitude,
            expression, and palette—not your stats.
          </p>
        </div>
      </div>

      <div
        class="share-preview"
        data-sentiment={sentiment}
        style={previewStyle}
        role="img"
        aria-label={previewLabel}
        aria-busy={refreshing}
      >
        <svg class="share-sentiment-face" viewBox="0 0 440 360" aria-hidden="true">
          <circle cx="220" cy="180" r="150"></circle>
          {#if sentiment === -2}
            <path d="M130 105l42 42m0-42-42 42M268 105l42 42m0-42-42 42"></path>
          {:else if sentiment === -1}
            <path d="M128 145l44-25m96 0 44 25"></path>
          {:else if sentiment === 0}
            <path d="M130 132h42m96 0h42"></path>
          {:else if sentiment === 1}
            <circle class="face-eye-fill" cx="151" cy="132" r="11"></circle>
            <circle class="face-eye-fill" cx="289" cy="132" r="11"></circle>
          {:else}
            <path class="face-eye-fill" d="M151 94l10 26 27 10-27 10-10 27-10-27-27-10 27-10zm138 0 10 26 27 10-27 10-10 27-10-27-27-10 27-10z"></path>
            <path class="face-spark-fill" d="M379 50l7 18 18 7-18 7-7 18-7-18-18-7 18-7zM62 259l5 13 13 5-13 5-5 13-5-13-13-5 13-5z"></path>
          {/if}
          <path d={sentiment === 0 ? 'M150 222h140' : `M150 222q70 ${sentiment * 38} 140 0`}></path>
          {#if sentiment === -2}
            <path class="face-accent" d="M174 262q23-18 46 0t46 0M190 276v28m58-27v38"></path>
          {/if}
        </svg>
        <div class="share-preview-header">
          <div class="share-brand-lockup">
            <strong>Token Envy</strong>
            <small>{SECURITY_BLUEPRINTS_CARD_LINE}</small>
          </div>
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
          <div class="share-preview-footer-row">
            <span>{card.count.toLocaleString('en-US')} measured requests · {card.sessions.toLocaleString('en-US')} sessions</span>
            <strong>{SHARE_INSTALL_CTA}</strong>
          </div>
          <span class="share-preview-refusals">{refusalLine}</span>
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
