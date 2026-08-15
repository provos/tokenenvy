<script lang="ts">
  import { untrack } from 'svelte';
  import LongitudinalShareModal from '../../../src/lib/components/LongitudinalShareModal.svelte';
  import type { LongitudinalSummary } from '../../../src/lib/types';

  interface Props {
    initialSummary: LongitudinalSummary;
    updatedSummary: LongitudinalSummary;
  }

  let { initialSummary, updatedSummary }: Props = $props();
  let open = $state(false);
  let summary = $state(untrack(() => initialSummary));
</script>

<button data-testid="open-longitudinal-share" type="button" onclick={() => (open = true)}>
  Open
</button>
<button data-testid="refresh-longitudinal" type="button" onclick={() => (summary = updatedSummary)}>
  Refresh
</button>

<LongitudinalShareModal {open} {summary} onclose={() => (open = false)} />
