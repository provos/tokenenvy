<script lang="ts">
  import { env } from '$env/dynamic/public';
  import { onMount } from 'svelte';
  import { SECURITY_BLUEPRINTS_CARD_LINE } from './brand';
  import { compactNumber, FAMILY_COLORS } from './chart';
  import { focusDialog, trapDialogTab } from './focus';
  import {
    safeWeeklyRecapProductLink,
    WEEKLY_RECAP_INSTALL_CTA,
    WEEKLY_RECAP_PRODUCT_URL,
    weeklyRecapCaption,
    weeklyRecapDayLabel,
    weeklyRecapHeadline,
    weeklyRecapIndexLine,
    weeklyRecapObservedWeekdays,
    weeklyRecapPeriod,
    weeklyRecapReady,
    weeklyRecapTopModel,
    type WeeklyRecapData
  } from './weekly-recap';

  interface Props {
    open: boolean;
    recap: WeeklyRecapData;
    outputTokens: number;
    onclose: () => void;
  }

  let { open, recap, outputTokens, onclose }: Props = $props();
  let modal = $state<HTMLElement>();
  let preparedFile = $state<File | null>(null);
  let preparing = $state(false);
  let nativeFileShareAvailable = $state(false);
  let clipboardImageAvailable = $state(false);
  let status = $state<string | null>(null);
  let renderVersion = 0;

  let productLink = $derived(
    safeWeeklyRecapProductLink(env.PUBLIC_TOKENENVY_URL ?? WEEKLY_RECAP_PRODUCT_URL)
  );
  let headline = $derived(weeklyRecapHeadline(recap));
  let indexLine = $derived(weeklyRecapIndexLine(recap));
  let period = $derived(weeklyRecapPeriod(recap));
  let topModel = $derived(weeklyRecapTopModel(recap));
  let observedWeekdays = $derived(weeklyRecapObservedWeekdays(recap));
  let ready = $derived(weeklyRecapReady(recap));
  let caption = $derived(weeklyRecapCaption(recap, productLink?.href ?? null));
  let previewLabel = $derived(
    `Token Envy weekly recap for ${period}. ${SECURITY_BLUEPRINTS_CARD_LINE}. ${headline}. ${Math.round(recap.median ?? 0)} median effective output tokens per second. ${indexLine}. ${recap.requestCount} measured requests across ${recap.sessions} sessions. Personal baseline only.`
  );
  let canExport = $derived(preparedFile !== null && ready && !preparing);

  onMount(() => {
    clipboardImageAvailable =
      typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
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
    const currentRecap = recap;
    const currentOutputTokens = outputTokens;
    if (!open || !ready) {
      renderVersion += 1;
      preparedFile = null;
      nativeFileShareAvailable = false;
      preparing = false;
      return;
    }
    void prepareCard(currentRecap, currentOutputTokens);
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

  async function prepareCard(currentRecap: WeeklyRecapData, currentOutputTokens: number) {
    const version = ++renderVersion;
    preparedFile = null;
    nativeFileShareAvailable = false;
    preparing = true;
    status = null;
    try {
      const blob = await renderCard(currentRecap, currentOutputTokens);
      if (version !== renderVersion) return;
      const file = new File(
        [blob],
        `token-envy-week-${currentRecap.throughDate}.png`,
        { type: 'image/png' }
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

  function renderCard(currentRecap: WeeklyRecapData, currentOutputTokens: number): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 630;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');

    const background = context.createLinearGradient(0, 0, 1200, 630);
    background.addColorStop(0, '#07151c');
    background.addColorStop(0.55, '#102a31');
    background.addColorStop(1, '#302a29');
    context.fillStyle = background;
    context.fillRect(0, 0, 1200, 630);

    const glow = context.createRadialGradient(600, 275, 10, 600, 275, 410);
    glow.addColorStop(0, 'rgba(95, 214, 189, 0.18)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, 1200, 630);

    drawWeekSignal(context, currentRecap);

    context.fillStyle = '#ff795f';
    context.font = '700 25px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText('TOKEN ENVY · WEEK SO FAR', 70, 65);

    context.fillStyle = 'rgba(242, 238, 230, 0.7)';
    context.font = '500 15px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText(SECURITY_BLUEPRINTS_CARD_LINE, 70, 91);

    context.textAlign = 'right';
    context.fillStyle = 'rgba(242, 238, 230, 0.7)';
    context.font = '500 23px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(weeklyRecapPeriod(currentRecap), 1130, 65);

    context.textAlign = 'center';
    context.fillStyle = '#f2eee6';
    context.font = '680 42px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(weeklyRecapHeadline(currentRecap), 600, 135);

    context.font = '750 132px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(`${Math.round(currentRecap.median ?? 0)}`, 600, 285);
    context.fillStyle = 'rgba(242, 238, 230, 0.68)';
    context.font = '650 23px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText('WEEKLY MEDIAN EFFECTIVE OUTPUT TOKENS / SECOND', 600, 326);

    context.fillStyle = '#5fd6bd';
    context.font = '650 25px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(weeklyRecapIndexLine(currentRecap), 600, 370);

    drawStandout(context, 70, 414, 500, currentRecap.fastestDay, 'FASTEST OBSERVED DAY');
    drawStandout(
      context,
      630,
      414,
      500,
      currentRecap.daysObserved === 1 ? null : currentRecap.slowestDay,
      currentRecap.daysObserved === 1 ? 'WEEK SO FAR' : 'SLOWEST OBSERVED DAY'
    );

    context.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(70, 544);
    context.lineTo(1130, 544);
    context.stroke();

    const model = weeklyRecapTopModel(currentRecap);
    const activity = [
      `${currentRecap.requestCount.toLocaleString('en-US')} requests`,
      `${currentRecap.sessions.toLocaleString('en-US')} sessions`,
      `${compactNumber(currentOutputTokens)} output tokens`,
      model ? `${capitalize(model.family)} ${Math.round(model.share * 100)}% of output` : null
    ].filter((item): item is string => item !== null).join(' · ');
    context.textAlign = 'left';
    context.fillStyle = 'rgba(242, 238, 230, 0.67)';
    context.font = '500 19px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(activity, 70, 582);

    context.textAlign = 'right';
    context.fillStyle = '#ff795f';
    context.font = '650 19px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(WEEKLY_RECAP_INSTALL_CTA, 1130, 582);

    context.textAlign = 'center';
    context.fillStyle = '#5fd6bd';
    context.font = '600 16px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText('Personal baseline · Prompts stayed local', 600, 612);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('PNG export failed'))),
        'image/png'
      );
    });
  }

  function drawWeekSignal(context: CanvasRenderingContext2D, currentRecap: WeeklyRecapData) {
    const observed = weeklyRecapObservedWeekdays(currentRecap);
    context.save();
    context.globalAlpha = 0.12;
    for (let day = 0; day < 7; day += 1) {
      const x = 310 + day * 97;
      const isObserved = observed.has(day);
      const radius = isObserved ? 20 : 11;
      context.beginPath();
      context.arc(x, 272, radius, 0, Math.PI * 2);
      context.fillStyle = isObserved ? '#5fd6bd' : '#f2eee6';
      context.fill();
      if (day < 6) {
        context.beginPath();
        context.moveTo(x + 25, 272);
        context.lineTo(x + 72, 272);
        context.strokeStyle = '#ff795f';
        context.lineWidth = 8;
        context.stroke();
      }
    }
    context.restore();
  }

  function drawStandout(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    day: { date: string; median: number } | null,
    label: string
  ) {
    context.fillStyle = 'rgba(255, 255, 255, 0.055)';
    context.beginPath();
    context.roundRect(x, y, width, 92, 16);
    context.fill();
    context.textAlign = 'left';
    context.fillStyle = 'rgba(242, 238, 230, 0.58)';
    context.font = '650 14px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText(label, x + 22, y + 28);
    context.fillStyle = '#f2eee6';
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
        text: caption
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
      const params = new URLSearchParams({ text: weeklyRecapCaption(recap, null) });
      if (productLink) params.set('url', productLink.href);
      url = `https://x.com/intent/tweet?${params.toString()}`;
    } else if (platform === 'bluesky') {
      url = `https://bsky.app/intent/compose?text=${encodeURIComponent(caption)}`;
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

  function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
</script>

<svelte:window onkeydown={trapFocus} />

{#if open}
  <button
    class="scrim share-scrim"
    type="button"
    aria-label="Close weekly recap"
    onclick={onclose}
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
        <p class="eyebrow">Week so far</p>
        <h2 id="weekly-recap-title">Your Token Envy recap</h2>
        <p>Compare this week with your own history. The image contains aggregate statistics only.</p>
      </div>
      <button
        class="icon-button"
        data-autofocus
        type="button"
        onclick={onclose}
        aria-label="Close weekly recap"
      >×</button>
    </header>

    <div class="share-body">
      <div class="weekly-recap-preview" role="img" aria-label={previewLabel}>
        <div class="weekly-recap-signal" aria-hidden="true">
          {#each Array(7) as _, index}
            <i
              class:observed={observedWeekdays.has(index)}
              data-weekday={index + 1}
              data-observed={observedWeekdays.has(index)}
            ></i>
          {/each}
        </div>
        <div class="weekly-recap-header">
          <div class="share-brand-lockup">
            <strong>Token Envy · Week so far</strong>
            <small>{SECURITY_BLUEPRINTS_CARD_LINE}</small>
          </div>
          <span>{period}</span>
        </div>
        <div class="weekly-recap-center">
          <p>{headline}</p>
          <strong>{Math.round(recap.median ?? 0)}</strong>
          <span>weekly median effective output tokens / second</span>
          <em>{indexLine}</em>
        </div>
        <div class="weekly-recap-standouts">
          {#if recap.fastestDay}
            <span>
              <small>{recap.daysObserved === 1 ? 'Observed day' : 'Fastest observed day'}</small>
              <strong>{weeklyRecapDayLabel(recap.fastestDay.date)}</strong>
              <em>{Math.round(recap.fastestDay.median)} effective tok/s</em>
            </span>
          {/if}
          {#if recap.daysObserved > 1 && recap.slowestDay}
            <span>
              <small>Slowest observed day</small>
              <strong>{weeklyRecapDayLabel(recap.slowestDay.date)}</strong>
              <em>{Math.round(recap.slowestDay.median)} effective tok/s</em>
            </span>
          {/if}
        </div>
        <div class="weekly-recap-footer">
          <span>
            {recap.requestCount.toLocaleString('en-US')} requests ·
            {recap.sessions.toLocaleString('en-US')} sessions ·
            {compactNumber(outputTokens)} output tokens
            {#if topModel} · {topModel.family} {Math.round(topModel.share * 100)}%{/if}
          </span>
          <strong>{WEEKLY_RECAP_INSTALL_CTA}</strong>
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
        <button class="secondary-button" type="button" onclick={downloadImage} disabled={!canExport}>
          {preparing ? 'Preparing PNG...' : 'Download PNG'}
        </button>
      </div>

      <section class="composer-guide" aria-labelledby="weekly-composer-title">
        <div>
          <p class="eyebrow">Compare personal weeks</p>
          <h3 id="weekly-composer-title">Invite a friend to bring their receipt</h3>
          <p>Each Speed Index compares one person with their own local history.</p>
        </div>
        <div class="composer-buttons">
          <button class="secondary-button" type="button" onclick={() => openComposer('x')}>Open X</button>
          <button class="secondary-button" type="button" onclick={() => openComposer('bluesky')}>Open Bluesky</button>
        </div>
        <div class="linkedin-guide">
          <strong>LinkedIn</strong>
          <button class="text-button" type="button" onclick={downloadImage} disabled={!canExport}>1. Download PNG</button>
          <button class="text-button" type="button" onclick={copyCaption}>2. Copy caption</button>
          <button class="text-button" type="button" onclick={() => openComposer('linkedin')}>3. Open LinkedIn</button>
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
