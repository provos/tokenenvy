<script lang="ts">
  import { env } from '$env/dynamic/public';
  import type { DailyPoint, ModelSummary, SpeedIndex } from '$lib/types';
  import { FAMILY_COLORS } from './chart';
  import { focusDialog, trapDialogTab } from './focus';
  import {
    buildShareCardData,
    getShareTagline,
    safeShareProductLink,
    shareTrendCoordinates,
    shareTrendPath,
    type ShareTone
  } from './share';

  interface Props {
    open: boolean;
    date: string;
    median: number;
    count: number;
    speedIndex: SpeedIndex;
    models: ModelSummary[];
    points: DailyPoint[];
    onclose: () => void;
  }

  let { open, date, median, count, speedIndex, models, points, onclose }: Props = $props();
  let tone = $state<ShareTone>('friendly');
  let status = $state<string | null>(null);
  let panel = $state<HTMLElement>();
  const productLink = safeShareProductLink(env.PUBLIC_CLAUDE_SPEEDOMETER_URL);
  const productAttribution = productLink?.label ?? 'Claude Speedometer';
  let card = $derived(buildShareCardData({ date, median, count, speedIndex, models, points }));
  let tagline = $derived(getShareTagline(tone, card));

  $effect(() => {
    if (open && panel) {
      const dialog = panel;
      const previous = document.activeElement as HTMLElement | null;
      tone = 'friendly';
      status = null;
      focusDialog(dialog);
      document.body.classList.add('overlay-open');
      return () => {
        document.body.classList.remove('overlay-open');
        previous?.focus?.();
      };
    }
  });

  function selectTone(next: ShareTone) {
    tone = next;
  }

  function onKeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') onclose();
    if (panel) trapDialogTab(event, panel);
  }

  function roundedRect(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
  ) {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
  }

  async function createCard(): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 630;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is not available');

    const gradient = context.createLinearGradient(0, 0, 1200, 630);
    gradient.addColorStop(0, '#111315');
    gradient.addColorStop(0.64, '#181716');
    gradient.addColorStop(1, '#231a17');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 1200, 630);

    context.fillStyle = 'rgba(255,115,89,.13)';
    context.beginPath();
    context.arc(1085, 20, 330, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = 'rgba(95,214,189,.07)';
    context.beginPath();
    context.arc(90, 660, 300, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = '#ff7359';
    roundedRect(context, 70, 62, 44, 44, 12);
    context.fill();
    context.fillStyle = '#151515';
    context.font = '700 27px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText('C', 82, 94);
    context.fillStyle = '#f5f1e9';
    context.font = '650 25px system-ui, -apple-system, sans-serif';
    context.fillText('CLAUDE SPEEDOMETER', 132, 92);
    context.fillStyle = '#9f9b94';
    context.font = '500 20px system-ui, -apple-system, sans-serif';
    context.textAlign = 'right';
    context.fillText(card.date, 1130, 91);
    context.textAlign = 'left';

    context.fillStyle = '#f5f1e9';
    context.font = '650 53px system-ui, -apple-system, sans-serif';
    context.fillText(tagline, 70, 196);

    context.fillStyle = '#ff7359';
    context.font = '700 136px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText(card.median.toFixed(1), 62, 370);
    context.fillStyle = '#b6b0a7';
    context.font = '600 28px system-ui, -apple-system, sans-serif';
    context.fillText('effective output tokens / second', 72, 414);
    context.fillStyle = card.indexEligible ? '#5fd6bd' : '#9f9b94';
    context.font = '600 20px system-ui, -apple-system, sans-serif';
    context.fillText(card.indexLabel, 72, 457);

    const cardX = 750;
    roundedRect(context, cardX, 210, 380, 250, 24);
    context.fillStyle = 'rgba(255,255,255,.055)';
    context.fill();
    context.fillStyle = '#9f9b94';
    context.font = '600 17px system-ui, -apple-system, sans-serif';
    context.fillText('LEADING OUTPUT MIX', cardX + 28, 245);
    card.models.forEach((model, index) => {
      const y = 278 + index * 24;
      context.fillStyle = FAMILY_COLORS[model.family];
      context.beginPath();
      context.arc(cardX + 34, y - 6, 6, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#f5f1e9';
      context.font = '600 20px system-ui, -apple-system, sans-serif';
      context.fillText(model.family, cardX + 53, y);
      context.textAlign = 'right';
      context.fillStyle = '#c2bdb5';
      context.fillText(`${Math.round(model.share * 100)}%`, cardX + 348, y);
      context.textAlign = 'left';
    });

    context.fillStyle = '#9f9b94';
    context.font = '600 14px system-ui, -apple-system, sans-serif';
    context.fillText('LAST 14 DAYS', cardX + 28, 383);
    context.save();
    context.translate(cardX + 28, 392);
    for (const model of card.models) {
      const coordinates = shareTrendCoordinates(card.trend, model.family, 324, 44);
      if (coordinates.length === 0) continue;
      context.beginPath();
      coordinates.forEach(({ x, y }, index) => {
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.strokeStyle = FAMILY_COLORS[model.family];
      context.lineWidth = 2;
      context.stroke();
      if (coordinates.length === 1) {
        context.beginPath();
        context.arc(coordinates[0].x, coordinates[0].y, 2.5, 0, Math.PI * 2);
        context.fillStyle = FAMILY_COLORS[model.family];
        context.fill();
      }
    }
    context.restore();

    context.strokeStyle = 'rgba(255,255,255,.12)';
    context.beginPath();
    context.moveTo(70, 504);
    context.lineTo(1130, 504);
    context.stroke();
    context.fillStyle = '#b6b0a7';
    context.font = '500 20px system-ui, -apple-system, sans-serif';
    context.fillText(`${card.count.toLocaleString()} measured requests · median, locally computed`, 70, 553);
    context.textAlign = 'right';
    context.fillStyle = '#f5f1e9';
    context.font = '600 20px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText(productAttribution, 1130, 553);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not render PNG'))), 'image/png');
    });
  }

  async function copyImage() {
    try {
      const blob = await createCard();
      if (!navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('Image copy is not supported here');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      status = 'Image copied — ready to paste.';
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not copy the image.';
    }
  }

  async function downloadImage() {
    try {
      const blob = await createCard();
      const link = document.createElement('a');
      link.download = `claude-speedometer-${card.date}.png`;
      link.href = URL.createObjectURL(blob);
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      status = 'Downloaded 1200 × 630 PNG.';
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not download the image.';
    }
  }

  async function nativeShare() {
    try {
      const blob = await createCard();
      const file = new File([blob], `claude-speedometer-${card.date}.png`, { type: 'image/png' });
      if (!navigator.share || !navigator.canShare?.({ files: [file] })) throw new Error('Native image sharing is not available here');
      await navigator.share({ title: tagline, text: 'My Claude Code performance today', files: [file] });
      status = 'Shared.';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      status = error instanceof Error ? error.message : 'Could not open sharing.';
    }
  }

  function openComposer(service: 'x' | 'bluesky') {
    const text = `${tagline} — ${card.median.toFixed(1)} effective output tokens/s. Made with Claude Speedometer.`;
    const url = service === 'x'
      ? `https://x.com/intent/post?text=${encodeURIComponent(text)}${productLink ? `&url=${encodeURIComponent(productLink.href)}` : ''}`
      : `https://bsky.app/intent/compose?text=${encodeURIComponent(productLink ? `${text} ${productLink.href}` : text)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    status = 'Composer opened. Attach the copied or downloaded image.';
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <button class="scrim share-scrim" aria-label="Close share dialog" onclick={onclose}></button>
  <div class="share-modal" bind:this={panel} role="dialog" aria-modal="true" aria-labelledby="share-title" tabindex="-1">
    <header class="drawer-header">
      <div>
        <p class="eyebrow">Privacy-safe by design</p>
        <h2 id="share-title">Share your speed</h2>
      </div>
      <button class="icon-button" data-autofocus aria-label="Close share dialog" onclick={onclose}>×</button>
    </header>

    <div class="share-body">
      <div class="tone-picker" aria-label="Share card tone">
        <button class:active={tone === 'friendly'} aria-pressed={tone === 'friendly'} onclick={() => selectTone('friendly')}>
          Friendly
        </button>
        <button class:active={tone === 'spicy'} aria-pressed={tone === 'spicy'} onclick={() => selectTone('spicy')}>
          Spicy
        </button>
      </div>

      <div class="share-preview" class:spicy={tone === 'spicy'} aria-label="Share image preview">
        <div class="share-preview-top">
          <span><b>C</b> Claude Speedometer</span>
          <span>{card.date}</span>
        </div>
        <h3>{tagline}</h3>
        <div class="share-number">{card.median.toFixed(1)}</div>
        <p>effective output tokens / second</p>
        <strong class:eligible={card.indexEligible} class="share-index">{card.indexLabel}</strong>
        {#if card.trend.length}
          <svg class="share-preview-trend" viewBox="0 0 320 54" role="img" aria-label="Fourteen-day model-family speed trend">
            {#each card.models as model}
              <path d={shareTrendPath(card.trend, model.family, 320, 54)} stroke={FAMILY_COLORS[model.family]} />
            {/each}
          </svg>
        {/if}
        <div class="share-preview-models">
          {#each card.models as model}
            <span><i style={`--model-color:${FAMILY_COLORS[model.family]}`}></i>{model.family} {Math.round(model.share * 100)}% output</span>
          {/each}
        </div>
        <footer>
          <span>{card.count.toLocaleString()} measured requests</span>
          {#if productLink}
            <a href={productLink.href} target="_blank" rel="noreferrer">{productLink.label}</a>
          {:else}
            <strong>Claude Speedometer</strong>
          {/if}
        </footer>
      </div>

      {#if !card.indexEligible}
        <p class="share-gate-note">The playful verdict unlocks after enough requests and baseline days. Your stats are still ready to share.</p>
      {/if}

      <div class="share-actions">
        <button class="primary-button" onclick={copyImage}>Copy image</button>
        <button class="secondary-button" onclick={downloadImage}>Download PNG</button>
        <button class="secondary-button" onclick={nativeShare}>Share…</button>
      </div>
      <div class="composer-actions">
        <span>Open a composer</span>
        <button onclick={() => openComposer('x')}>X</button>
        <button onclick={() => openComposer('bluesky')}>Bluesky</button>
      </div>
      <p class="privacy-copy">Only the aggregate numbers visible above enter the image. Prompts, projects, and session identifiers never do.</p>
      <p class="share-status" aria-live="polite">{status ?? ''}</p>
    </div>
  </div>
{/if}
