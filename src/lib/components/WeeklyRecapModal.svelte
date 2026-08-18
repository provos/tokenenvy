<script lang="ts">
  import { env } from '$env/dynamic/public';
  import { onMount, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { SECURITY_BLUEPRINTS_CARD_LINE } from './brand';
  import { compactNumber } from './chart';
  import { focusDialog, trapDialogTab } from './focus';
  import {
    drawFailureStamp,
    FAILURE_MARK,
    failureStampStyle,
    getShareSentimentTheme,
    normalizeShareSentiment,
    SHARE_SENTIMENTS,
    type ShareSentiment,
    type ShareTone,
  } from './share';
  import {
    safeWeeklyRecapProductLink,
    suggestedWeeklySentiment,
    WEEKLY_RECAP_INSTALL_CTA,
    WEEKLY_RECAP_PRODUCT_URL,
    weeklyRecapCaption,
    weeklyRecapDayLabel,
    weeklyRecapFailureLine,
    weeklyRecapFailureStamp,
    weeklyRecapHeadline,
    weeklyRecapImageFilename,
    weeklyRecapIndexLine,
    weeklyRecapObservedWeekdays,
    weeklyRecapPeriod,
    weeklyRecapReady,
    weeklyRecapRefusalLine,
    weeklyRecapRefusalNote,
    weeklyRecapSentimentDescription,
    weeklyRecapTextReceipt,
    weeklyRecapTopModel,
    type WeeklyRecapData,
  } from './weekly-recap';

  interface Props {
    open: boolean;
    recap: WeeklyRecapData;
    outputTokens: number;
    onclose: () => void;
  }

  interface WeeklyShareSnapshot {
    recap: WeeklyRecapData;
    outputTokens: number;
  }

  let { open, recap, outputTokens, onclose }: Props = $props();
  let modal = $state<HTMLElement>();
  let tone = $state<ShareTone>('friendly');
  let sentiment = $state<ShareSentiment>(0);
  let preparedFile = $state<File | null>(null);
  let preparing = $state(false);
  let nativeFileShareAvailable = $state(false);
  let clipboardImageAvailable = $state(false);
  let status = $state<string | null>(null);
  let previousOpen = false;
  let renderVersion = 0;

  function captureInputs(): WeeklyShareSnapshot {
    return {
      recap: {
        ...recap,
        observedDates: [...recap.observedDates],
        speedIndex: { ...recap.speedIndex },
        models: recap.models.map((model) => ({ ...model })),
        fastestDay: recap.fastestDay ? { ...recap.fastestDay } : null,
        slowestDay: recap.slowestDay ? { ...recap.slowestDay } : null,
        refusals: {
          ...recap.refusals,
          affectedDates: recap.refusals.affectedDates.map((day) => ({ ...day })),
        },
        failures: {
          ...recap.failures,
          affectedDates: recap.failures.affectedDates.map((day) => ({ ...day })),
        },
      },
      outputTokens,
    };
  }

  let inputSnapshot = $state<WeeklyShareSnapshot>(captureInputs());
  let snapshotRecap = $derived(inputSnapshot.recap);
  let snapshotOutputTokens = $derived(inputSnapshot.outputTokens);

  let productLink = $derived(
    safeWeeklyRecapProductLink(env.PUBLIC_TOKENENVY_URL ?? WEEKLY_RECAP_PRODUCT_URL),
  );
  let theme = $derived(getShareSentimentTheme(sentiment));
  let headline = $derived(weeklyRecapHeadline(snapshotRecap, tone, sentiment));
  let indexLine = $derived(weeklyRecapIndexLine(snapshotRecap));
  let period = $derived(weeklyRecapPeriod(snapshotRecap));
  let topModel = $derived(weeklyRecapTopModel(snapshotRecap));
  let observedWeekdays = $derived(weeklyRecapObservedWeekdays(snapshotRecap));
  let refusalWeekdays = $derived(weeklyRefusalWeekdays(snapshotRecap));
  let refusalLine = $derived(weeklyRecapRefusalLine(snapshotRecap));
  let refusalNote = $derived(weeklyRecapRefusalNote(snapshotRecap));
  let failureStamp = $derived(weeklyRecapFailureStamp(snapshotRecap));
  let failureLine = $derived(weeklyRecapFailureLine(snapshotRecap));
  let sentimentDescription = $derived(weeklyRecapSentimentDescription(snapshotRecap));
  let ready = $derived(weeklyRecapReady(snapshotRecap));
  let caption = $derived(
    weeklyRecapCaption(snapshotRecap, tone, sentiment, productLink?.href ?? null),
  );
  let previewLabel = $derived(
    `Token Envy weekly recap for ${period}. ${SECURITY_BLUEPRINTS_CARD_LINE}. ${theme.accessibleLabel} mood. ${headline}. ${Math.round(snapshotRecap.median ?? 0)} median effective output tokens per second. ${indexLine}. ${snapshotRecap.requestCount} measured requests across ${snapshotRecap.sessions} sessions.${refusalLine ? ` ${refusalLine}. ${refusalNote}` : ''}${failureLine ? ` ${failureLine}.` : ''} ${WEEKLY_RECAP_INSTALL_CTA}. Personal baseline only.`,
  );
  let canExport = $derived(preparedFile !== null && ready && !preparing);
  const weekdayIndices = [0, 1, 2, 3, 4, 5, 6] as const;

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
    inputSnapshot = untrack(captureInputs);
    tone = 'friendly';
    sentiment = suggestedWeeklySentiment(inputSnapshot.recap);
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
    const currentRecap = snapshotRecap;
    const currentOutputTokens = snapshotOutputTokens;
    const currentTone = tone;
    const currentSentiment = sentiment;
    if (!open || !ready) {
      renderVersion += 1;
      preparedFile = null;
      nativeFileShareAvailable = false;
      preparing = false;
      return;
    }
    void prepareCard(currentRecap, currentOutputTokens, currentTone, currentSentiment);
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

  async function prepareCard(
    currentRecap: WeeklyRecapData,
    currentOutputTokens: number,
    currentTone: ShareTone,
    currentSentiment: ShareSentiment,
  ) {
    const version = ++renderVersion;
    preparedFile = null;
    nativeFileShareAvailable = false;
    preparing = true;
    status = null;
    try {
      const blob = await renderCard(
        currentRecap,
        currentOutputTokens,
        currentTone,
        currentSentiment,
      );
      if (version !== renderVersion) return;
      const file = new File(
        [blob],
        weeklyRecapImageFilename(currentRecap, currentTone, currentSentiment),
        { type: 'image/png' },
      );
      preparedFile = file;
      nativeFileShareAvailable =
        typeof navigator.share === 'function' &&
        typeof navigator.canShare === 'function' &&
        navigator.canShare({ files: [file] });
    } catch {
      if (version === renderVersion) status = 'The weekly image could not be prepared. Try again.';
    } finally {
      if (version === renderVersion) preparing = false;
    }
  }

  function renderCard(
    currentRecap: WeeklyRecapData,
    currentOutputTokens: number,
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
    background.addColorStop(0.55, currentTheme.backgroundMiddle);
    background.addColorStop(1, currentTheme.backgroundEnd);
    context.fillStyle = background;
    context.fillRect(0, 0, 1200, 630);

    const glow = context.createRadialGradient(600, 275, 10, 600, 275, 410);
    glow.addColorStop(0, currentTheme.glow);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, 1200, 630);

    drawWeekSignal(context, currentRecap, currentTheme);

    context.fillStyle = currentTheme.secondary;
    context.font = '700 25px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText('TOKEN ENVY · WEEK SO FAR', 70, 65);

    context.fillStyle = currentTheme.mutedText;
    context.font = '500 15px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText(SECURITY_BLUEPRINTS_CARD_LINE, 70, 91);

    context.textAlign = 'right';
    context.fillStyle = currentTheme.mutedText;
    context.font = '500 23px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(weeklyRecapPeriod(currentRecap), 1130, 65);

    // Trails the period: a note about the service this week, held apart from the
    // refusal line so the two axes never read as one number.
    drawFailureStamp(context, {
      right: 1130,
      top: 74,
      label: weeklyRecapFailureStamp(currentRecap),
      theme: currentTheme,
    });

    context.textAlign = 'center';
    context.fillStyle = currentTheme.text;
    context.font = '680 42px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(weeklyRecapHeadline(currentRecap, currentTone, currentSentiment), 600, 135);

    context.font = '750 132px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(`${Math.round(currentRecap.median ?? 0)}`, 600, 285);
    context.fillStyle = currentTheme.mutedText;
    context.font = '650 23px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText('WEEKLY MEDIAN EFFECTIVE OUTPUT · TOK/S', 600, 326);

    context.fillStyle = currentTheme.accent;
    context.font = '650 25px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(weeklyRecapIndexLine(currentRecap), 600, 370);

    drawStandout(
      context,
      70,
      414,
      500,
      currentRecap.fastestDay,
      'FASTEST OBSERVED DAY',
      currentTheme,
    );
    drawStandout(
      context,
      630,
      414,
      500,
      currentRecap.daysObserved === 1 ? null : currentRecap.slowestDay,
      currentRecap.daysObserved === 1 ? 'WEEK SO FAR' : 'SLOWEST OBSERVED DAY',
      currentTheme,
    );

    const currentRefusalLine = weeklyRecapRefusalLine(currentRecap);
    if (currentRefusalLine) {
      const currentRefusalNote = weeklyRecapRefusalNote(currentRecap);
      context.textAlign = 'center';
      context.fillStyle =
        currentRecap.refusals.userVisible > 0
          ? '#ff826f'
          : currentRecap.refusals.attempted > 0
            ? '#f0bd68'
            : currentTheme.mutedText;
      context.font = '650 16px Inter, ui-sans-serif, system-ui, sans-serif';
      context.fillText(
        `${currentRecap.refusals.attempted > 0 ? '▲ ' : ''}${currentRefusalLine}${currentRefusalNote ? ` · ${currentRefusalNote}` : ''}`,
        600,
        530,
        1060,
      );
    }

    context.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(70, 547);
    context.lineTo(1130, 547);
    context.stroke();

    const model = weeklyRecapTopModel(currentRecap);
    const activity = [
      `${currentRecap.requestCount.toLocaleString('en-US')} requests`,
      `${currentRecap.sessions.toLocaleString('en-US')} sessions`,
      `${compactNumber(currentOutputTokens)} output tokens`,
      model ? `${capitalize(model.family)} ${Math.round(model.share * 100)}% of output` : null,
    ]
      .filter((item): item is string => item !== null)
      .join(' · ');
    context.textAlign = 'left';
    context.fillStyle = currentTheme.mutedText;
    context.font = '500 19px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(activity, 70, 582);

    context.textAlign = 'right';
    context.fillStyle = currentTheme.secondary;
    context.font = '650 19px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(WEEKLY_RECAP_INSTALL_CTA, 1130, 582);

    context.textAlign = 'center';
    context.fillStyle = currentTheme.accent;
    context.font = '600 16px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText('Personal baseline · Prompts stayed local', 600, 612);

    context.save();
    context.strokeStyle = 'rgba(255, 255, 255, 0.24)';
    context.lineWidth = 2;
    context.strokeRect(2, 2, 1196, 626);
    context.restore();

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('PNG export failed'))),
        'image/png',
      );
    });
  }

  function drawWeekSignal(
    context: CanvasRenderingContext2D,
    currentRecap: WeeklyRecapData,
    currentTheme: ReturnType<typeof getShareSentimentTheme>,
  ) {
    const observed = weeklyRecapObservedWeekdays(currentRecap);
    const refusals = weeklyRefusalWeekdays(currentRecap);
    context.save();
    context.globalAlpha = 0.12;
    for (let day = 0; day < 7; day += 1) {
      const x = 310 + day * 97;
      const isObserved = observed.has(day);
      const radius = isObserved ? 20 : 11;
      context.beginPath();
      context.arc(x, 272, radius, 0, Math.PI * 2);
      context.fillStyle = isObserved ? currentTheme.accent : currentTheme.text;
      context.fill();
      if (day < 6) {
        context.beginPath();
        context.moveTo(x + 25, 272);
        context.lineTo(x + 72, 272);
        context.strokeStyle = currentTheme.secondary;
        context.lineWidth = 8;
        context.stroke();
      }
    }
    context.restore();
    for (const [day, refusal] of refusals) {
      drawWarningTriangle(context, 310 + day * 97, 237, refusal.userVisible > 0);
    }
  }

  function drawWarningTriangle(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    userVisible: boolean,
  ) {
    context.save();
    context.beginPath();
    context.moveTo(x, y - 10);
    context.lineTo(x + 9, y + 7);
    context.lineTo(x - 9, y + 7);
    context.closePath();
    context.fillStyle = userVisible ? '#ff826f' : '#f0bd68';
    context.strokeStyle = 'rgba(7, 13, 18, 0.78)';
    context.lineWidth = 2;
    context.fill();
    context.stroke();
    context.restore();
  }

  function weeklyRefusalWeekdays(
    currentRecap: WeeklyRecapData,
  ): Map<number, WeeklyRecapData['refusals']['affectedDates'][number]> {
    const weekdays = new SvelteMap<number, WeeklyRecapData['refusals']['affectedDates'][number]>();
    for (const day of currentRecap.refusals.affectedDates) {
      if (
        day.attempted <= 0 ||
        day.date < currentRecap.weekStart ||
        day.date > currentRecap.throughDate
      )
        continue;
      const parsed = new Date(`${day.date}T12:00:00Z`);
      if (!Number.isFinite(parsed.getTime())) continue;
      weekdays.set((parsed.getUTCDay() + 6) % 7, day);
    }
    return weekdays;
  }

  function drawStandout(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    day: { date: string; median: number } | null,
    label: string,
    currentTheme: ReturnType<typeof getShareSentimentTheme>,
  ) {
    context.fillStyle = 'rgba(255, 255, 255, 0.055)';
    context.beginPath();
    context.roundRect(x, y, width, 92, 16);
    context.fill();
    context.textAlign = 'left';
    context.fillStyle = currentTheme.mutedText;
    context.font = '650 14px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(label, x + 22, y + 28);
    context.fillStyle = currentTheme.text;
    context.font = '650 24px Inter, ui-sans-serif, system-ui, sans-serif';
    const value = day
      ? `${weeklyRecapDayLabel(day.date)} · ${Math.round(day.median)} effective tok/s`
      : 'One observed day';
    context.fillText(value, x + 22, y + 66);
  }

  async function copyImage() {
    if (!preparedFile || !clipboardImageAvailable) return;
    status = null;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': preparedFile })]);
      status = 'Weekly image copied. Paste or attach it in your composer.';
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
    status = 'Weekly PNG downloaded. Attach it in your composer.';
  }

  async function nativeShare() {
    if (!preparedFile || !nativeFileShareAvailable) return;
    status = null;
    try {
      await navigator.share({
        files: [preparedFile],
        title: 'My Token Envy weekly recap',
        text: caption,
      });
      status = 'Share sheet opened with the weekly image attached.';
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        status = 'Sharing was blocked. Download the PNG instead.';
      }
    }
  }

  function openComposer(platform: 'x' | 'bluesky' | 'linkedin') {
    let url: string;
    if (platform === 'x') {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Local composer parameters are serialized immediately.
      const params = new URLSearchParams({
        text: weeklyRecapCaption(snapshotRecap, tone, sentiment, null, 'x'),
      });
      if (productLink) params.set('url', productLink.href);
      url = `https://x.com/intent/tweet?${params.toString()}`;
    } else if (platform === 'bluesky') {
      url = `https://bsky.app/intent/compose?text=${encodeURIComponent(
        weeklyRecapCaption(snapshotRecap, tone, sentiment, productLink?.href ?? null, 'bluesky'),
      )}`;
    } else {
      url = 'https://www.linkedin.com/feed/';
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    status = `${platform === 'x' ? 'X' : capitalize(platform)} opened. Attach the copied or downloaded PNG.`;
  }

  async function copyCaption() {
    status = null;
    try {
      await navigator.clipboard.writeText(caption);
      status = 'Weekly caption copied.';
    } catch {
      status = 'Caption copy was blocked. Grant clipboard access and try again.';
    }
  }

  async function copyTextReceipt() {
    status = null;
    try {
      await navigator.clipboard.writeText(
        weeklyRecapTextReceipt(snapshotRecap, tone, sentiment, productLink?.href ?? null),
      );
      status = 'Weekly text receipt copied.';
    } catch {
      status = 'Text copy was blocked. Grant clipboard access and try again.';
    }
  }

  function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
</script>

<svelte:window onkeydown={trapFocus} />

{#if open}
  <button class="scrim share-scrim" type="button" aria-label="Close weekly recap" onclick={onclose}
  ></button>
  <div
    class="share-modal weekly-recap-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="weekly-recap-title"
    tabindex="-1"
    bind:this={modal}
  >
    <header class="drawer-header">
      <div>
        <p class="eyebrow">Weekly receipt</p>
        <h2 id="weekly-recap-title">Give the week a verdict</h2>
        <p>The card freezes this week and compares it with your own history.</p>
      </div>
      <button
        class="icon-button"
        data-autofocus
        type="button"
        onclick={onclose}
        aria-label="Close weekly recap">×</button
      >
    </header>

    <div class="share-body">
      <div class="share-controls weekly-share-controls">
        <div class="voice-control">
          <span class="share-control-label">Voice</span>
          <div class="tone-control" role="group" aria-label="Weekly card voice">
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
        <div class="sentiment-control" style={`--sentiment-accent:${theme.accent}`}>
          <div class="sentiment-heading">
            <label for="weekly-sentiment">Card mood</label>
            <strong>{theme.label}</strong>
          </div>
          <input
            id="weekly-sentiment"
            type="range"
            min="-2"
            max="2"
            step="1"
            value={sentiment}
            aria-valuetext={theme.accessibleLabel}
            aria-describedby="weekly-sentiment-description"
            oninput={(event) =>
              (sentiment = normalizeShareSentiment(Number(event.currentTarget.value)))}
          />
          <div class="sentiment-labels" aria-hidden="true">
            {#each SHARE_SENTIMENTS as value (value)}<span class:active={value === sentiment}
                >{getShareSentimentTheme(value).label}</span
              >{/each}
          </div>
          <p id="weekly-sentiment-description">{sentimentDescription}</p>
        </div>
      </div>

      <div
        class="weekly-recap-preview"
        role="img"
        aria-label={previewLabel}
        style={`--weekly-bg-start:${theme.backgroundStart};--weekly-bg-middle:${theme.backgroundMiddle};--weekly-bg-end:${theme.backgroundEnd};--weekly-accent:${theme.accent};--weekly-secondary:${theme.secondary};--weekly-text:${theme.text};--weekly-muted:${theme.mutedText};--weekly-glow:${theme.glow};${failureStampStyle(theme)}`}
      >
        <div class="weekly-recap-signal" aria-hidden="true">
          {#each weekdayIndices as index (index)}
            {@const refusal = refusalWeekdays.get(index)}
            <i
              class:observed={observedWeekdays.has(index)}
              class:affected={Boolean(refusal)}
              class:user-visible={(refusal?.userVisible ?? 0) > 0}
              data-weekday={index + 1}
              data-observed={observedWeekdays.has(index)}
              data-refusal-attempted={refusal?.attempted ?? 0}
            ></i>
          {/each}
        </div>
        <div class="weekly-recap-header">
          <div class="share-brand-lockup">
            <strong>Token Envy · Week so far</strong>
            <small>{SECURITY_BLUEPRINTS_CARD_LINE}</small>
          </div>
          <div class="share-preview-context">
            <span>{period}</span>
            {#if failureStamp}
              <span class="share-failure-stamp"
                ><i aria-hidden="true">{FAILURE_MARK}</i><span>{failureStamp}</span></span
              >
            {/if}
          </div>
        </div>
        <div class="weekly-recap-center">
          <p>{headline}</p>
          <strong>{Math.round(snapshotRecap.median ?? 0)}</strong>
          <span>weekly median effective output · tok/s</span>
          <em>{indexLine}</em>
        </div>
        <div class="weekly-recap-standouts">
          {#if snapshotRecap.fastestDay}
            <span>
              <small
                >{snapshotRecap.daysObserved === 1 ? 'Observed day' : 'Fastest observed day'}</small
              >
              <strong>{weeklyRecapDayLabel(snapshotRecap.fastestDay.date)}</strong>
              <em>{Math.round(snapshotRecap.fastestDay.median)} effective tok/s</em>
            </span>
          {/if}
          {#if snapshotRecap.daysObserved > 1 && snapshotRecap.slowestDay}
            <span>
              <small>Slowest observed day</small>
              <strong>{weeklyRecapDayLabel(snapshotRecap.slowestDay.date)}</strong>
              <em>{Math.round(snapshotRecap.slowestDay.median)} effective tok/s</em>
            </span>
          {/if}
        </div>
        <div class="weekly-recap-footer">
          <span>
            {snapshotRecap.requestCount.toLocaleString('en-US')} requests ·
            {snapshotRecap.sessions.toLocaleString('en-US')} sessions ·
            {compactNumber(snapshotOutputTokens)} output tokens
            {#if topModel}
              · {topModel.family} {Math.round(topModel.share * 100)}%{/if}
          </span>
          <strong>{WEEKLY_RECAP_INSTALL_CTA}</strong>
          <span
            class="weekly-recap-refusals"
            class:attempted={snapshotRecap.refusals.attempted > 0}
            class:user-visible={snapshotRecap.refusals.userVisible > 0}
            >{snapshotRecap.refusals.attempted > 0 ? '▲ ' : ''}{refusalLine}{refusalNote
              ? ` · ${refusalNote}`
              : ''}</span
          >
          <small>Personal baseline · Prompts stayed local</small>
        </div>
      </div>

      <p class="weekly-context-note">
        Speed Index adjusts for your model and output-size mix. Fastest and slowest day use raw
        effective tok/s and belong to this week only.
      </p>

      <div class="share-actions" aria-label="Prepare the weekly image">
        {#if nativeFileShareAvailable}
          <button class="primary-button" type="button" onclick={nativeShare} disabled={!canExport}>
            Share image...
          </button>
        {/if}
        {#if clipboardImageAvailable}
          <button class="secondary-button" type="button" onclick={copyImage} disabled={!canExport}>
            Copy image
          </button>
        {/if}
        <button
          class="secondary-button"
          type="button"
          onclick={downloadImage}
          disabled={!canExport}
        >
          {preparing ? 'Preparing PNG...' : 'Download PNG'}
        </button>
        <button class="secondary-button" type="button" onclick={copyTextReceipt}>
          Copy text receipt
        </button>
      </div>

      <section class="composer-guide" aria-labelledby="weekly-composer-title">
        <div>
          <p class="eyebrow">Compare weeks</p>
          <h3 id="weekly-composer-title">How did Claude Code treat everyone else?</h3>
          <p>Post the recap. Ask a friend to bring theirs.</p>
        </div>
        <div class="composer-buttons">
          <button class="secondary-button" type="button" onclick={() => openComposer('x')}
            >Open X</button
          >
          <button class="secondary-button" type="button" onclick={() => openComposer('bluesky')}
            >Open Bluesky</button
          >
        </div>
        <div class="linkedin-guide">
          <strong>LinkedIn</strong>
          <button class="text-button" type="button" onclick={downloadImage} disabled={!canExport}
            >1. Download PNG</button
          >
          <button class="text-button" type="button" onclick={copyCaption}>2. Copy caption</button>
          <button class="text-button" type="button" onclick={() => openComposer('linkedin')}
            >3. Open LinkedIn</button
          >
        </div>
      </section>

      <p class="privacy-note">
        The recap excludes prompts, responses, project names, paths, and session identifiers.
      </p>
      <p class="share-status" aria-live="polite">
        {status ?? (preparing ? 'Preparing the weekly PNG...' : '')}
      </p>
    </div>
  </div>
{/if}
