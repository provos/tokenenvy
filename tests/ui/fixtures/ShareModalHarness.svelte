<script lang="ts">
  import { untrack } from 'svelte';
  import ShareModal from '../../../src/lib/components/ShareModal.svelte';
  import type { ShareRefusalCounts } from '../../../src/lib/components/share';
  import type { DayDetailResponse } from '../../../src/lib/types';

  interface Props {
    initialDetail: DayDetailResponse;
    updatedDetail: DayDetailResponse;
    initialRefusals: ShareRefusalCounts;
    updatedRefusals: ShareRefusalCounts;
  }

  let { initialDetail, updatedDetail, initialRefusals, updatedRefusals }: Props = $props();
  let open = $state(false);
  let detail = $state(untrack(() => initialDetail));
  let refusals = $state(untrack(() => initialRefusals));

  function updateInBackground() {
    detail = updatedDetail;
    refusals = updatedRefusals;
  }
</script>

<button data-testid="open-share" type="button" onclick={() => (open = true)}>Open</button>
<button data-testid="refresh-day" type="button" onclick={updateInBackground}>Refresh</button>

<ShareModal {open} {detail} {refusals} isToday={true} onclose={() => (open = false)} />
