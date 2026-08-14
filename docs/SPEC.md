# Token Envy v2 specification

Token Envy is a local-only Svelte 5 dashboard for performance metadata
derived from Claude Code JSONL transcripts. It scans the configured projects
directory read-only, writes only privacy-safe derived records to its own app-data
directory, and makes no automatic network requests.

## Fixed product decisions

- The metric is always named **effective output tokens/s**. It measures output
  tokens divided by inferred end-to-end request wall time and is not raw decoder
  speed.
- Daily summaries use an explicit IANA timezone over UTC timestamps. Changing
  timezone recomputes day boundaries.
- The default chart is median plus IQR. A clustered confidence interval is
  optional and appears only with at least 20 requests and five sessions.
- The adjusted daily index compares the selected day with the preceding 28
  complete local days within model family and output-size strata. Fixed baseline
  weights prevent today's model mix from redefining the comparison.
- Performance taglines require at least 20 requests, five sessions, seven
  baseline days, 100 baseline requests, and sufficient stratum coverage.
  Friendly is the default; spicy is an explicit choice for the current share. A five-stop valence slider defaults from the eligible mix-adjusted comparable-day result (neutral without a baseline) and lets the user vary editorial sentiment from strongly negative to strongly positive. The automatic extremes require a percentile at or beyond 10/90, an index at or beyond 90/110, and a confidence interval wholly below/above 100. Moderate suggestions require the 35th/65th percentile and an index on the matching side of 100. It changes the card's wording, vector expression, and palette, never its measurements, and resets when the dialog is reopened.
- Classifier reporting uses explicit metadata only and distinguishes attempted,
  recovered-by-fallback, user-visible, and unknown outcomes.
- Transcript-only weekly numbers are labelled observed usage, never quota.
  Exact five-hour and seven-day percentages are available only through an
  explicitly configured local status-line companion.
- Precision/OTel mode is out of scope.

## Security and privacy invariants

- Default input is `~/.claude/projects/**/*.jsonl`; the scanner never crawls all
  of `~/.claude`. One or more explicit CLI roots replace that default rather
  than expanding it.
- The derived index and local status-line connection live in `~/.tokenenvy`
  unless the user explicitly sets `TOKENENVY_DATA_DIR`.
- The HTTP server binds to loopback. Host and Origin are validated; CORS is not
  enabled; production browser access uses a one-time bootstrap token and strict
  cookie.
- Persisted identifiers and source paths are HMAC digests. The key is local
  pseudonymization, not encryption.
- Stable request and refusal summaries move into a compact content-free archive
  after 24 hours. That archive survives later upstream transcript cleanup and
  `--rescan`; live transcript-derived rows remain retractable.
- No prompts, response text, tool inputs or outputs, commands, project names,
  raw paths, refusal categories or explanations, or raw identifiers are persisted or returned.
- Share cards are built from an allowlisted aggregate object and contain no
  local identifiers. They may show the selected day's aggregate explicit
  refusal counts, labeled as a lower bound, but never refusal categories or
  explanations. Every card includes the static `npx tokenenvy` install command;
  user-triggered social navigation links to the public npm package page unless
  a valid public HTTPS product URL is configured.

## Scanner correctness

- Files are tailed from the last complete newline. Partial lines remain pending.
- Replayed rows are idempotent. Copied history is deduplicated by event UUID.
- UUID-less records use a per-occurrence digest and carry a data-quality flag.
- Replaced, truncated, and deleted files retract their event occurrences. A
  logical event disappears only when its final occurrence disappears, after
  which affected requests and daily aggregates are recomputed.
- A request may be shown as provisional after two idle minutes, but any later
  content reopens and recomputes it. Idle time is never proof of completion.
- Requests and refusal outcomes become durable historical summaries only after
  24 hours of stability; no prompt or response content is added to the archive.
- Synthetic, non-positive-token, missing-parent, invalid-time, sub-100 ms, and
  hour-scale intervals are excluded with explicit quality reasons.

## Release acceptance

- Fixtures cover copied history, partial/malformed rows, late request parts,
  truncation/replacement/deletion, missing parents, model aliases, refusal
  fallback, DST, and quota reset windows.
- Clean and incrementally chunked scans converge to identical API results.
- A canary fixture proves private strings are absent from DB, API, logs, and PNG.
- The observed 1.5 GB corpus indexes in under 120 seconds with under 500 MB RSS;
  the UI remains available with visible progress.
- The packed npm tarball installs from an empty directory, scans two explicit
  roots through the installed `tokenenvy` bin, and shuts down cleanly.
- Keyboard, reduced-motion, 200% zoom, 360 px layout, empty states, and share
  preview are validated in a browser.
