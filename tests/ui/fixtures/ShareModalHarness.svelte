<script lang="ts">
  import { untrack } from 'svelte';
  import ShareModal from '../../../src/lib/components/ShareModal.svelte';
  import type { ShareFailureCounts, ShareRefusalCounts } from '../../../src/lib/components/share';
  import type { DayDetailResponse } from '../../../src/lib/types';

  interface Props {
    initialDetail: DayDetailResponse;
    updatedDetail: DayDetailResponse;
    initialRefusals: ShareRefusalCounts;
    updatedRefusals: ShareRefusalCounts;
    initialFailures: ShareFailureCounts;
    updatedFailures: ShareFailureCounts;
  }

  let {
    initialDetail,
    updatedDetail,
    initialRefusals,
    updatedRefusals,
    initialFailures,
    updatedFailures,
  }: Props = $props();
  let open = $state(false);
  let detail = $state(untrack(() => initialDetail));
  let refusals = $state(untrack(() => initialRefusals));
  let failures = $state(untrack(() => initialFailures));

  function updateInBackground() {
    detail = updatedDetail;
    refusals = updatedRefusals;
    failures = updatedFailures;
  }
</script>

<button data-testid="open-share" type="button" onclick={() => (open = true)}>Open</button>
<button data-testid="refresh-day" type="button" onclick={updateInBackground}>Refresh</button>

<ShareModal {open} {detail} {refusals} {failures} isToday={true} onclose={() => (open = false)} />
