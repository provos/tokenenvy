<script lang="ts">
  import { FAILURE_MARK } from './share';

  interface Props {
    /** Already-composed stamp text. Empty means there is nothing to stamp. */
    label: string;
  }

  let { label }: Props = $props();
</script>

<!--
  This markup is load-bearing: `app.css` styles the mark and the ellipsised label
  through the class below and the span nested inside it, and the card tests match
  on both. The tags stay glued together so the text carries no stray whitespace.
-->
{#if label}
  <span class="share-failure-stamp"
    ><i aria-hidden="true">{FAILURE_MARK}</i><span>{label}</span></span
  >
{/if}
