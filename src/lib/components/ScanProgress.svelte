<script module lang="ts">
	import type { ScanStatus } from '$lib/types';

	export function formatScanBytes(bytes: number): string {
		if (bytes < 1_024) return `${bytes} B`;
		if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
		if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
		return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
	}

	export function scanPercent(status: ScanStatus | null): number | null {
		if (status?.state !== 'scanning' || status.filesDiscovered === 0) return null;
		return Math.round(Math.min(1, status.filesScanned / status.filesDiscovered) * 100);
	}
</script>

<script lang="ts">
	interface Props {
		status: ScanStatus | null;
	}

	let { status }: Props = $props();
	let percent = $derived(scanPercent(status));
	let headline = $derived.by(() => {
		if (!status || (status.state === 'idle' && status.updatedAt === null)) return 'Starting the local scanner…';
		if (status.state === 'discovering') return 'Finding Claude Code session logs…';
		if (status.state === 'scanning') return 'Indexing your local history…';
		if (status.state === 'error') return 'The scanner needs attention';
		return 'Finalizing dashboard statistics…';
	});
	let detail = $derived.by(() => {
		if (!status) return 'Connecting to the scanner';
		if (status.state === 'error') return status.lastError ?? 'The latest scan did not finish.';
		if (status.state === 'discovering') {
			return status.filesDiscovered > 0
				? `${status.filesDiscovered.toLocaleString('en-US')} log files found so far`
				: 'Searching your configured log folders';
		}
		if (status.state === 'scanning') {
			return `${status.filesScanned.toLocaleString('en-US')} of ${status.filesDiscovered.toLocaleString('en-US')} files · ${formatScanBytes(status.bytesRead)} read · ${status.rowsRead.toLocaleString('en-US')} rows inspected`;
		}
		return status.filesDiscovered > 0
			? `${status.filesDiscovered.toLocaleString('en-US')} files indexed · preparing charts`
			: 'Preparing the first dashboard response';
	});
</script>

<div class="scan-progress" class:scan-error={status?.state === 'error'}>
	<div class="scan-progress-heading">
		<strong>{headline}</strong>
		{#if percent !== null}<span>{percent}%</span>{/if}
	</div>
	{#if percent !== null && status}
		<progress
			max={status.filesDiscovered}
			value={Math.min(status.filesScanned, status.filesDiscovered)}
			aria-label={`${percent}% of discovered files indexed`}
		></progress>
	{:else}
		<progress aria-label={headline}></progress>
	{/if}
	<p>{detail}</p>
</div>
