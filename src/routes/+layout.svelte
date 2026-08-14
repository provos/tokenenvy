<script lang="ts">
  import '../app.css';
  let { children } = $props();
</script>

<svelte:head>
  <title>Claude Speedometer</title>
  <meta
    name="description"
    content="A private, local-first performance dashboard for Claude Code session logs."
  />
  <meta name="theme-color" content="#111315" />
</svelte:head>

{@render children()}
