<script lang="ts">
	import type { HistogramBin } from '$lib/types';
	import { normalizeHistogram } from './share';

	interface Props {
		bins: HistogramBin[];
		median: number;
	}

	let { bins, median }: Props = $props();
	let bars = $derived(normalizeHistogram(bins, median));
</script>

<div class="histogram-backdrop" aria-hidden="true">
	{#each bars as bar, index (`${bar.lower}-${bar.upper}-${index}`)}
		<span
			class:median-bin={bar.containsMedian}
			style={`--bar-height: ${Math.max(0.035, bar.height)}`}
		></span>
	{/each}
</div>
