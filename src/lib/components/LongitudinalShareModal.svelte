<script module lang="ts">
  export function refusalMarkerLineDash(unattributed: boolean): number[] {
    return unattributed ? [4, 3] : [];
  }

  export function refusalCanvasLineColor(
    index: number,
    attempted: number,
    userVisible: number,
    mutedColor: string,
  ): string {
    if (index > 0 || attempted === 0) return mutedColor;
    return userVisible > 0 ? '#ff826f' : '#f0bd68';
  }
</script>

<script lang="ts">
  import { env } from '$env/dynamic/public';
  import { onMount, untrack } from 'svelte';
  import type { LongitudinalPoint, LongitudinalSummary } from '$lib/types';
  import { SECURITY_BLUEPRINTS_CARD_LINE } from './brand';
  import { compactNumber } from './chart';
  import { focusDialog, trapDialogTab } from './focus';
  import {
    longitudinalCaption,
    longitudinalFamilyLabel,
    longitudinalHeadline,
    longitudinalImageFilename,
    LONGITUDINAL_INSTALL_CTA,
    longitudinalMetricLabel,
    longitudinalRangeLabel,
    longitudinalRefusalLines,
    longitudinalSentimentDescription,
    longitudinalTrendLabel,
    suggestedLongitudinalSentiment,
  } from './longitudinal-share';
  import { fitTextLines } from './share-layout';
  import { selectedLongitudinalRefusalCounts } from './refusal-mood';
  import {
    DEFAULT_SHARE_PRODUCT_URL,
    getShareSentimentTheme,
    normalizeShareSentiment,
    safeShareProductLink,
    SHARE_SENTIMENTS,
    type ShareSentiment,
    type ShareTone,
  } from './share';

  interface Props {
    open: boolean;
    summary: LongitudinalSummary;
    onclose: () => void;
  }

  let { open, summary, onclose }: Props = $props();
  let modal = $state<HTMLElement>();
  let snapshot = $state<LongitudinalSummary>(captureSummary());
  let tone = $state<ShareTone>('friendly');
  let sentiment = $state<ShareSentiment>(0);
  let preparedFile = $state<File | null>(null);
  let preparing = $state(false);
  let clipboardImageAvailable = $state(false);
  let nativeFileShareAvailable = $state(false);
  let status = $state<string | null>(null);
  let previousOpen = false;
  let renderVersion = 0;

  let theme = $derived(getShareSentimentTheme(sentiment));
  let headline = $derived(longitudinalHeadline(tone, sentiment));
  let metricLabel = $derived(longitudinalMetricLabel(snapshot));
  let trendLabel = $derived(longitudinalTrendLabel(snapshot));
  let refusalLines = $derived(longitudinalRefusalLines(snapshot));
  let refusalCounts = $derived(selectedLongitudinalRefusalCounts(snapshot));
  let hasRefusalAttempt = $derived(
    snapshot.refusals.some((day) => day.selected.attempted > 0 || day.unattributed.attempted > 0),
  );
  let sentimentDescription = $derived(longitudinalSentimentDescription(snapshot));
  let refusalDescription = $derived(
    refusalLines.length > 0
      ? refusalLines.join('. ')
      : snapshot.refusalsRecorded
        ? ''
        : 'Explicit refusal signals unavailable',
  );
  let familyLabel = $derived(longitudinalFamilyLabel(snapshot.families));
  let rangeLabel = $derived(longitudinalRangeLabel(snapshot.days));
  let productLink = $derived(
    safeShareProductLink(env.PUBLIC_TOKENENVY_URL ?? DEFAULT_SHARE_PRODUCT_URL),
  );
  let caption = $derived(longitudinalCaption(snapshot, tone, sentiment, productLink?.href ?? null));
  let plotPoints = $derived(plot(snapshot.points, snapshot.startDate, snapshot.throughDate));
  let previewLabel = $derived(
    `Token Envy Claude weather. ${SECURITY_BLUEPRINTS_CARD_LINE}. ${theme.accessibleLabel} mood. ${headline}. ${snapshot.variationPct === null ? metricLabel : `${Math.round(snapshot.variationPct)} percent ${metricLabel}`}. ${trendLabel}. ${snapshot.measuredOutputTokens} measured output tokens across ${snapshot.measuredRequests} requests and ${snapshot.observedDays} observed days.${refusalDescription ? ` ${refusalDescription}.` : ''} ${familyLabel}, ${rangeLabel} view. ${LONGITUDINAL_INSTALL_CTA}.`,
  );
  let canExport = $derived(preparedFile !== null && !preparing);

  function captureSummary(): LongitudinalSummary {
    return {
      ...summary,
      families: [...summary.families],
      points: summary.points.map((point) => ({ ...point })),
      refusals: summary.refusals.map((day) => ({
        date: day.date,
        selected: { ...day.selected },
        unattributed: { ...day.unattributed },
      })),
    };
  }

  onMount(() => {
    clipboardImageAvailable =
      typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
  });

  $effect(() => {
    if (!open) {
      previousOpen = false;
      return;
    }
    if (previousOpen) return;
    previousOpen = true;
    snapshot = untrack(captureSummary);
    tone = 'friendly';
    sentiment = suggestedLongitudinalSentiment(snapshot);
    status = null;
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
    const currentSnapshot = snapshot;
    const currentTone = tone;
    const currentSentiment = sentiment;
    if (!open || currentSnapshot.measuredRequests === 0) {
      renderVersion += 1;
      preparedFile = null;
      preparing = false;
      return;
    }
    void prepareCard(currentSnapshot, currentTone, currentSentiment);
  });

  function onKeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
      return;
    }
    if (modal) trapDialogTab(event, modal);
  }

  async function prepareCard(
    currentSummary: LongitudinalSummary,
    currentTone: ShareTone,
    currentSentiment: ShareSentiment,
  ) {
    const version = ++renderVersion;
    preparedFile = null;
    nativeFileShareAvailable = false;
    preparing = true;
    status = null;
    try {
      const blob = await renderCard(currentSummary, currentTone, currentSentiment);
      if (version !== renderVersion) return;
      const file = new File(
        [blob],
        longitudinalImageFilename(currentSummary, currentTone, currentSentiment),
        { type: 'image/png' },
      );
      preparedFile = file;
      nativeFileShareAvailable =
        typeof navigator.share === 'function' &&
        typeof navigator.canShare === 'function' &&
        navigator.canShare({ files: [file] });
    } catch {
      if (version === renderVersion) status = 'The weather image could not be prepared. Try again.';
    } finally {
      if (version === renderVersion) preparing = false;
    }
  }

  function renderCard(
    currentSummary: LongitudinalSummary,
    currentTone: ShareTone,
    currentSentiment: ShareSentiment,
  ): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 630;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    const currentTheme = getShareSentimentTheme(currentSentiment);
    const background = context.createLinearGradient(0, 0, 1200, 630);
    background.addColorStop(0, currentTheme.backgroundStart);
    background.addColorStop(0.56, currentTheme.backgroundMiddle);
    background.addColorStop(1, currentTheme.backgroundEnd);
    context.fillStyle = background;
    context.fillRect(0, 0, 1200, 630);
    context.strokeStyle = currentTheme.outline;
    context.lineWidth = 4;
    context.strokeRect(10, 10, 1180, 610);

    drawWeatherAtmosphere(context, currentSentiment, currentTheme.accent);
    context.fillStyle = currentTheme.accent;
    context.font = '700 25px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText('TOKEN ENVY · CLAUDE WEATHER', 62, 58);
    context.fillStyle = currentTheme.mutedText;
    context.font = '500 15px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText(SECURITY_BLUEPRINTS_CARD_LINE, 62, 84);
    context.textAlign = 'right';
    context.font = '600 19px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(
      `${longitudinalRangeLabel(currentSummary.days)} · ${longitudinalFamilyLabel(currentSummary.families)}`,
      1138,
      61,
    );

    context.textAlign = 'left';
    const currentHeadline = longitudinalHeadline(currentTone, currentSentiment);
    const fitted = fitTextLines(currentHeadline, {
      maxWidth: 1060,
      maxLines: 2,
      maxHeight: 74,
      maxFontSize: 44,
      minFontSize: 30,
      measure: (fontSize, text) => {
        context.font = `700 ${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
        return context.measureText(text).width;
      },
    });
    context.fillStyle = currentTheme.text;
    context.font = `700 ${fitted.fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
    fitted.lines.forEach((line, index) =>
      context.fillText(line, 62, 126 + index * fitted.lineHeight),
    );

    context.font = '760 102px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(
      currentSummary.variationPct === null
        ? compactNumber(currentSummary.measuredOutputTokens)
        : `${Math.round(currentSummary.variationPct)}%`,
      62,
      282,
    );
    context.fillStyle = currentTheme.mutedText;
    context.font = '650 17px Inter, ui-sans-serif, system-ui, sans-serif';
    wrapCanvasText(
      context,
      longitudinalMetricLabel(currentSummary).toUpperCase(),
      62,
      316,
      300,
      21,
    );

    drawLongitudinalPlot(context, currentSummary, currentTheme);

    context.fillStyle = currentTheme.accent;
    context.font = '650 21px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(longitudinalTrendLabel(currentSummary), 62, 397);
    const refusalLines = longitudinalRefusalLines(currentSummary);
    const refusalCounts = selectedLongitudinalRefusalCounts(currentSummary);
    const hasRefusalAttempt = currentSummary.refusals.some(
      (day) => day.selected.attempted > 0 || day.unattributed.attempted > 0,
    );
    context.font = '600 17px Inter, ui-sans-serif, system-ui, sans-serif';
    refusalLines.slice(0, 2).forEach((line, index) => {
      context.fillStyle = refusalCanvasLineColor(
        index,
        refusalCounts.attempted,
        refusalCounts.userVisible,
        currentTheme.mutedText,
      );
      context.fillText(`${hasRefusalAttempt ? '▲ ' : ''}${line}`, 62, 437 + index * 25);
    });

    context.strokeStyle = 'rgba(255,255,255,0.14)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(62, 493);
    context.lineTo(1138, 493);
    context.stroke();
    context.fillStyle = currentTheme.text;
    context.font = '650 21px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(
      `${compactNumber(currentSummary.measuredOutputTokens)} measured output tokens · ${currentSummary.measuredRequests.toLocaleString('en-US')} requests · ${currentSummary.observedDays} observed days`,
      62,
      532,
    );
    context.fillStyle = currentTheme.mutedText;
    context.font = '500 15px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(
      `${Math.round(currentSummary.comparableRequestCoverage * 100)}% comparable coverage · ${currentSummary.quality} estimate · prompts stayed local`,
      62,
      565,
    );
    context.textAlign = 'right';
    context.fillStyle = currentTheme.accent;
    context.font = '700 20px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(LONGITUDINAL_INSTALL_CTA, 1138, 605);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('PNG export failed'))),
        'image/png',
      );
    });
  }

  function drawLongitudinalPlot(
    context: CanvasRenderingContext2D,
    currentSummary: LongitudinalSummary,
    currentTheme: ReturnType<typeof getShareSentimentTheme>,
  ) {
    const points = plot(
      currentSummary.points,
      currentSummary.startDate,
      currentSummary.throughDate,
    );
    const left = 410;
    const top = 180;
    const width = 728;
    const height = 205;
    context.save();
    context.translate(left, top);
    context.strokeStyle = 'rgba(255,255,255,0.1)';
    context.lineWidth = 1;
    for (const part of [0, 0.5, 1]) {
      context.beginPath();
      context.moveTo(0, part * height);
      context.lineTo(width, part * height);
      context.stroke();
    }
    if (points.length > 0) {
      context.beginPath();
      points.forEach((point, index) => {
        const x = point.x * width;
        const y = point.y * height;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.strokeStyle = currentTheme.accent;
      context.lineWidth = 5;
      context.lineJoin = 'round';
      context.lineCap = 'round';
      context.stroke();
    }
    for (const refusal of currentSummary.refusals) {
      const x =
        dateFraction(refusal.date, currentSummary.startDate, currentSummary.throughDate) * width;
      const selectedAttempt = refusal.selected.attempted > 0;
      const unattributedAttempt = refusal.unattributed.attempted > 0;
      const markerInset = selectedAttempt && unattributedAttempt ? 20 : 10;
      const markerX = Math.max(markerInset, Math.min(width - markerInset, x));
      if (selectedAttempt) {
        drawWarningTriangle(
          context,
          markerX + (unattributedAttempt ? -9 : 0),
          -11,
          refusal.selected.userVisible > 0,
          false,
        );
      }
      if (unattributedAttempt) {
        drawWarningTriangle(context, markerX + (selectedAttempt ? 9 : 0), -11, false, true);
      }
    }
    context.restore();
  }

  function drawWarningTriangle(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    userVisible: boolean,
    unattributed: boolean,
  ) {
    context.beginPath();
    context.moveTo(x, y - 8);
    context.lineTo(x + 8, y + 7);
    context.lineTo(x - 8, y + 7);
    context.closePath();
    context.fillStyle = userVisible
      ? '#ff826f'
      : unattributed
        ? 'rgba(220,225,230,0.18)'
        : '#f0bd68';
    context.strokeStyle = unattributed ? 'rgba(220,225,230,0.75)' : context.fillStyle;
    context.lineWidth = 2;
    context.setLineDash(refusalMarkerLineDash(unattributed));
    context.fill();
    context.stroke();
  }

  function drawWeatherAtmosphere(
    context: CanvasRenderingContext2D,
    currentSentiment: ShareSentiment,
    accent: string,
  ) {
    context.save();
    context.globalAlpha = currentSentiment === 0 ? 0.08 : 0.12;
    context.strokeStyle = accent;
    context.lineWidth = currentSentiment < 0 ? 9 : 5;
    for (let line = 0; line < 4; line += 1) {
      context.beginPath();
      context.moveTo(390, 145 + line * 72);
      context.bezierCurveTo(590, 95 + line * 65, 820, 220 + line * 20, 1160, 130 + line * 70);
      context.stroke();
    }
    context.restore();
  }

  function wrapCanvasText(
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
  ) {
    const words = text.split(' ');
    let line = '';
    let lineIndex = 0;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (context.measureText(next).width > maxWidth && line) {
        context.fillText(line, x, y + lineIndex * lineHeight);
        line = word;
        lineIndex += 1;
      } else line = next;
    }
    if (line) context.fillText(line, x, y + lineIndex * lineHeight);
  }

  async function copyImage() {
    if (!preparedFile || !clipboardImageAvailable) return;
    status = null;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': preparedFile })]);
      status = 'Weather image copied. Paste or attach it in your composer.';
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
    status = 'Weather PNG downloaded. Attach it in your composer.';
  }

  async function copyCaption() {
    status = null;
    try {
      await navigator.clipboard.writeText(caption);
      status = 'Weather caption copied.';
    } catch {
      status = 'Caption copy was blocked. Grant clipboard access and try again.';
    }
  }

  async function nativeShare() {
    if (!preparedFile || !nativeFileShareAvailable) return;
    status = null;
    try {
      await navigator.share({ files: [preparedFile], title: 'My Claude weather', text: caption });
      status = 'Share sheet opened with the weather image attached.';
    } catch (error) {
      if ((error as Error).name !== 'AbortError')
        status = 'Sharing was blocked. Download the PNG instead.';
    }
  }

  function openComposer(platform: 'x' | 'bluesky' | 'linkedin') {
    let url: string;
    if (platform === 'x') {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Local composer parameters are serialized immediately.
      const params = new URLSearchParams({
        text: longitudinalCaption(snapshot, tone, sentiment, null, 'x'),
      });
      if (productLink) params.set('url', productLink.href);
      url = `https://x.com/intent/tweet?${params.toString()}`;
    } else if (platform === 'bluesky') {
      url = `https://bsky.app/intent/compose?text=${encodeURIComponent(
        longitudinalCaption(snapshot, tone, sentiment, productLink?.href ?? null, 'bluesky'),
      )}`;
    } else {
      url = 'https://www.linkedin.com/feed/';
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    status = `${platform === 'x' ? 'X' : platform === 'bluesky' ? 'Bluesky' : 'LinkedIn'} opened. Attach the copied or downloaded PNG.`;
  }

  function dateFraction(date: string, start: string, end: string): number {
    const parse = (value: string) => Date.parse(`${value}T00:00:00Z`);
    const span = Math.max(1, parse(end) - parse(start));
    return Math.max(0, Math.min(1, (parse(date) - parse(start)) / span));
  }

  function plot(points: LongitudinalPoint[], start: string, end: string) {
    if (points.length === 0) return [];
    const values = points.map((point) => point.index);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const padding = Math.max(5, (high - low) * 0.12);
    const minimum = low - padding;
    const span = Math.max(1, high + padding - minimum);
    return points.map((point) => ({
      date: point.date,
      x: dateFraction(point.date, start, end),
      y: 1 - (point.index - minimum) / span,
    }));
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <button
    class="scrim share-scrim"
    type="button"
    aria-label="Close Claude weather"
    onclick={onclose}
  ></button>
  <div
    class="share-modal longitudinal-share-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="longitudinal-share-title"
    tabindex="-1"
    bind:this={modal}
  >
    <header class="drawer-header">
      <div>
        <p class="eyebrow">Claude weather</p>
        <h2 id="longitudinal-share-title">Put your Claude weather on the map</h2>
        <p>The card freezes this range and the model filters you picked.</p>
      </div>
      <button
        class="icon-button"
        data-autofocus
        type="button"
        onclick={onclose}
        aria-label="Close Claude weather">×</button
      >
    </header>

    <div class="share-body">
      <div class="share-controls longitudinal-share-controls">
        <div class="voice-control">
          <span class="share-control-label">Voice</span>
          <div class="tone-control" role="group" aria-label="Claude weather card voice">
            <button
              type="button"
              class:active={tone === 'friendly'}
              aria-pressed={tone === 'friendly'}
              onclick={() => (tone = 'friendly')}>Friendly</button
            >
            <button
              type="button"
              class:active={tone === 'spicy'}
              aria-pressed={tone === 'spicy'}
              onclick={() => (tone = 'spicy')}>Spicy</button
            >
          </div>
        </div>
        <div class="sentiment-control">
          <div class="sentiment-heading">
            <label for="longitudinal-sentiment">Card mood</label>
            <strong>{theme.label}</strong>
          </div>
          <input
            id="longitudinal-sentiment"
            type="range"
            min="-2"
            max="2"
            step="1"
            value={sentiment}
            aria-valuetext={theme.label}
            aria-describedby="longitudinal-sentiment-description"
            oninput={(event) =>
              (sentiment = normalizeShareSentiment(Number(event.currentTarget.value)))}
          />
          <div class="sentiment-labels" aria-hidden="true">
            {#each SHARE_SENTIMENTS as value (value)}<span class:active={value === sentiment}
                >{getShareSentimentTheme(value).label}</span
              >{/each}
          </div>
          <p id="longitudinal-sentiment-description">{sentimentDescription}</p>
        </div>
      </div>

      <div
        class="longitudinal-share-preview"
        role="img"
        aria-label={previewLabel}
        style={`--weather-start:${theme.backgroundStart};--weather-middle:${theme.backgroundMiddle};--weather-end:${theme.backgroundEnd};--weather-accent:${theme.accent};--weather-text:${theme.text};--weather-muted:${theme.mutedText}`}
      >
        <div class="longitudinal-weather-lines" aria-hidden="true"><i></i><i></i><i></i></div>
        <header>
          <div class="share-brand-lockup">
            <strong>Token Envy · Claude Weather</strong><small
              >{SECURITY_BLUEPRINTS_CARD_LINE}</small
            >
          </div>
          <span>{rangeLabel} · {familyLabel}</span>
        </header>
        <div class="longitudinal-share-copy">
          <p>{headline}</p>
          <strong
            >{snapshot.variationPct === null
              ? compactNumber(snapshot.measuredOutputTokens)
              : `${Math.round(snapshot.variationPct)}%`}</strong
          >
          <span>{metricLabel}</span>
          <em>{trendLabel}</em>
        </div>
        <svg class="longitudinal-share-chart" viewBox="0 0 720 220" aria-hidden="true">
          <line x1="0" x2="720" y1="20" y2="20"></line><line x1="0" x2="720" y1="110" y2="110"
          ></line><line x1="0" x2="720" y1="200" y2="200"></line>
          {#if plotPoints.length}
            <polyline
              points={plotPoints.map((point) => `${point.x * 720},${point.y * 180 + 20}`).join(' ')}
            ></polyline>
          {/if}
          {#each snapshot.refusals as refusal (refusal.date)}
            {@const x = dateFraction(refusal.date, snapshot.startDate, snapshot.throughDate) * 720}
            {@const selectedAttempt = refusal.selected.attempted > 0}
            {@const unattributedAttempt = refusal.unattributed.attempted > 0}
            {@const markerInset = selectedAttempt && unattributedAttempt ? 18 : 9}
            {@const markerX = Math.max(markerInset, Math.min(720 - markerInset, x))}
            {#if selectedAttempt}
              {@const selectedX = markerX + (unattributedAttempt ? -8 : 0)}
              <path
                class:user-visible={refusal.selected.userVisible > 0}
                d={`M ${selectedX} 1 L ${selectedX + 7} 14 L ${selectedX - 7} 14 Z`}
              ></path>
            {/if}
            {#if unattributedAttempt}
              {@const unattributedX = markerX + (selectedAttempt ? 8 : 0)}
              <path
                class="unattributed"
                d={`M ${unattributedX} 1 L ${unattributedX + 7} 14 L ${unattributedX - 7} 14 Z`}
              ></path>
            {/if}
          {/each}
        </svg>
        <div
          class="longitudinal-refusal-copy"
          class:attempted={refusalCounts.attempted > 0}
          class:user-visible={refusalCounts.userVisible > 0}
        >
          {#each refusalLines as line (line)}<span>{hasRefusalAttempt ? '▲ ' : ''}{line}</span
            >{/each}
        </div>
        <footer>
          <span
            >{compactNumber(snapshot.measuredOutputTokens)} measured output tokens · {snapshot.measuredRequests.toLocaleString(
              'en-US',
            )} requests · {snapshot.observedDays} observed days</span
          >
          <strong>{LONGITUDINAL_INSTALL_CTA}</strong>
          <small
            >{Math.round(snapshot.comparableRequestCoverage * 100)}% comparable coverage · {snapshot.quality}
            estimate · prompts stayed local</small
          >
        </footer>
      </div>

      <div class="share-actions" aria-label="Prepare the weather image">
        {#if nativeFileShareAvailable}<button
            class="primary-button"
            type="button"
            onclick={nativeShare}
            disabled={!canExport}>Share image...</button
          >{/if}
        {#if clipboardImageAvailable}<button
            class="secondary-button"
            type="button"
            onclick={copyImage}
            disabled={!canExport}>Copy image</button
          >{/if}
        <button class="secondary-button" type="button" onclick={downloadImage} disabled={!canExport}
          >{preparing ? 'Preparing PNG...' : 'Download PNG'}</button
        >
        <button class="secondary-button" type="button" onclick={copyCaption}>Copy caption</button>
      </div>

      <section class="composer-guide" aria-labelledby="longitudinal-composer-title">
        <div>
          <p class="eyebrow">Compare forecasts</p>
          <h3 id="longitudinal-composer-title">How wild is your Claude weather?</h3>
          <p>Post the chart. Ask a friend to chart theirs.</p>
        </div>
        <div class="composer-buttons">
          <button class="secondary-button" type="button" onclick={() => openComposer('x')}
            >Open X</button
          ><button class="secondary-button" type="button" onclick={() => openComposer('bluesky')}
            >Open Bluesky</button
          >
        </div>
        <div class="linkedin-guide">
          <strong>LinkedIn</strong><button
            class="text-button"
            type="button"
            onclick={downloadImage}
            disabled={!canExport}>1. Download PNG</button
          ><button class="text-button" type="button" onclick={copyCaption}>2. Copy caption</button
          ><button class="text-button" type="button" onclick={() => openComposer('linkedin')}
            >3. Open LinkedIn</button
          >
        </div>
      </section>
      {#if !snapshot.refusalsRecorded}<p class="privacy-note">
          Explicit refusal signals are unavailable in these logs.
        </p>{/if}
      <p class="privacy-note">
        The image contains aggregate measurements only. Prompts and responses stay local.
      </p>
      <p class="share-status" aria-live="polite">
        {status ?? (preparing ? 'Preparing the weather PNG...' : '')}
      </p>
    </div>
  </div>
{/if}
