<script lang="ts">
  import { untrack } from 'svelte';
  import WeeklyRecapModal from '../../../src/lib/components/WeeklyRecapModal.svelte';
  import type { WeeklyRecapData } from '../../../src/lib/components/weekly-recap';

  interface Props {
    initialRecap: WeeklyRecapData;
    updatedRecap: WeeklyRecapData;
    initialOutputTokens: number;
    updatedOutputTokens: number;
  }

  let { initialRecap, updatedRecap, initialOutputTokens, updatedOutputTokens }: Props = $props();
  let open = $state(false);
  let recap = $state(untrack(() => initialRecap));
  let outputTokens = $state(untrack(() => initialOutputTokens));

  function updateInBackground() {
    recap = updatedRecap;
    outputTokens = updatedOutputTokens;
  }
</script>

<button data-testid="open-weekly-share" type="button" onclick={() => (open = true)}>Open</button>
<button data-testid="refresh-week" type="button" onclick={updateInBackground}>Refresh</button>

<WeeklyRecapModal {open} {recap} {outputTokens} onclose={() => (open = false)} />
