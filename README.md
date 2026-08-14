# Token Envy

Token Envy is a private, local-first performance dashboard for Claude Code. It continuously indexes performance metadata from Claude Code JSONL transcripts and turns it into model-by-model throughput trends, daily distributions, refusal outcomes, observed usage, and privacy-safe share cards.

Token Envy is a [Security Blueprints](https://securityblueprints.io/) project created by Niels Provos.

It does not need an LLM, an Anthropic API key, telemetry, or an internet connection. The web server listens only on the loopback interface and the transcript directory is always read-only.

## What it shows

- Effective output tokens/s for Opus, Sonnet, Fable, Haiku, and other models
- Daily medians, interquartile ranges, sample sizes, and statistically eligible confidence intervals
- A 28-day mix-adjusted speed index that does not let today's model mix redefine its own baseline
- Drill-down histograms, hourly medians, selected-day refusal outcomes, exclusions, and data-quality counts
- Explicit classifier refusals split into attempted, recovered by fallback, user-visible, and unknown
- Observed weekly output and a projection based on the current week
- A separate Week so far recap with a personal Speed Index, observed high and low days, and aggregate activity
- Optional five-hour and seven-day rate-limit percentages from Claude Code's local status-line payload
- Downloadable selected-day histogram share images with friendly or user-enabled spicy taglines and an adjustable five-stop mood

The spicy share voice is an explicit choice in the share dialog. Each dialog opens in the friendly default. A five-stop negative-to-positive mood slider changes the card's editorial tagline, vector expression, and palette without changing its measurements. The initial mood follows a conservative, mix-adjusted comparable-day recommendation when available and stays neutral while the baseline is warming up. Extreme moods require an unusual percentile, a material adjusted difference, and a confidence interval entirely on the same side of baseline; users can always move the slider elsewhere.

## Install and run

Token Envy requires Node.js 22.13 or newer.

The CLI checks the runtime before loading the server or SQLite. Older versions receive a clear upgrade message and exit before startup.

Run it directly from npm with:

```bash
npx tokenenvy
```

From this checkout:

```bash
npm install
npm run build
npm link
tokenenvy
```

The CLI prints the loopback address and normally opens it in the default browser. The initial browser URL has a one-time random access token; a `SameSite=Strict`, HTTP-only cookie is used after that token is redeemed. A fresh token is created on every server launch.

By default, the scanner reads `~/.claude/projects/**/*.jsonl`. One or more `--logs` options replace that default. Repeat the option to monitor multiple transcript roots; Token Envy deduplicates roots and removes nested overlaps rather than scanning the same file twice. It never broadens an explicit path into a crawl of the whole Claude directory.

```bash
tokenenvy \
  --logs ~/.claude/projects \
  --logs /Volumes/archive/claude-projects \
  --port 4173 \
  --timezone America/Los_Angeles \
  --no-open
```

### CLI options

| Option | Meaning |
| --- | --- |
| `--logs PATH` | Replace the default transcript root; repeat for additional roots |
| `--port PORT` | Listen on this loopback port; default is `4173` |
| `--timezone ZONE` | Use this IANA timezone for calendar-day boundaries |
| `--no-open` | Start without opening a browser |
| `--rescan` | Re-read live transcripts while preserving archived history and usage samples |
| `-h`, `--help` | Print CLI help |

The watcher remains active while the server process runs. Stop it with Ctrl-C. The derived SQLite index, its pseudonymization key, and a compact content-free history of stable requests and refusal outcomes live in `~/.tokenenvy`. Stable summaries are archived after 24 hours so statistics survive upstream transcript cleanup. Set `TOKENENVY_DATA_DIR` to override that location. When launching the built server without the CLI, `TOKENENVY_LOGS` must be a JSON array of transcript-root paths.

## Optional rate-limit display

Transcript totals are not an account quota: Claude web, Desktop, and Code may share limits, and the service decides the actual allowance. Token Envy therefore labels transcript-only totals as **observed usage**.

Claude Code can provide current five-hour and seven-day percentages to a status-line command. To opt in, add a status-line command to your own Claude settings:

```json
{
  "statusLine": {
    "type": "command",
    "command": "tokenenvy statusline"
  }
}
```

Token Envy never creates or overwrites `~/.claude/settings.json`. If you already use a status-line command, integrate the helper into that command rather than replacing it blindly.

The companion reads the JSON Claude supplies on stdin, immediately discards everything except valid `five_hour` and `seven_day` rate-limit fields, and posts that small projection to the active loopback server with a per-launch secret. Its network timeout is 150 ms, and a stopped dashboard never delays or breaks Claude Code. The latest sample becomes stale after 15 minutes or after its reset time.

## Understanding the metric

The dashboard deliberately calls its primary metric **effective output tokens/s**. It divides reported output tokens by the wall-clock interval inferred from linked transcript events. That interval can include queueing, prompt processing, hidden reasoning, time to first output, and local timestamp effects. It is useful for comparing experienced performance, but it is not raw decoder speed.

Distributions are typically skewed, so the dashboard leads with medians and interquartile ranges rather than averages. Very short, hour-scale, missing-parent, invalid-time, synthetic, and non-positive-token observations are excluded and counted by reason. A request can be provisional while its transcript is still being appended and may be recomputed later; provisional requests are counted separately and excluded from displayed analytics until they settle.

Changing `--timezone` changes calendar boundaries and daily aggregates. Copied or forked transcript history is deduplicated by event identity, and incremental scans are designed to converge with a clean scan.

## Privacy and security

- Transcript files are opened read-only. Prompts, responses, commands, tool data, project names, raw paths, refusal categories or explanations, and raw identifiers are neither persisted nor returned by the API.
- Source, session, request, and event identifiers in the derived database are locally keyed HMAC digests. This is pseudonymization, not encryption.
- The server binds to `127.0.0.1`; Host and Origin values must also be explicit loopback names. CORS is not enabled.
- Production browser sessions require the one-time launch token. Status-line ingestion uses a different per-launch bearer secret.
- The app makes no automatic outbound requests and includes no analytics or telemetry.
- Share cards are created from an allowlisted aggregate object. Review the preview, then explicitly download, copy, or invoke the browser's share sheet. Social sites are never contacted merely by opening the dashboard.

Anyone able to read your local user account may be able to access the derived index, so normal workstation security still matters.

## Social sharing

Open any measured day, choose **Share this day**, select the friendly or spicy voice, adjust the mood from negative through neutral to positive, and export the generated PNG. Mood changes only the editorial wording and visual treatment; the displayed statistics remain unchanged. The card contains that day's aggregate statistics, model mix, selected-day histogram, explicit refusal lower-bound counts, Token Envy attribution, Security Blueprints attribution, and a **Run it yourself · npx tokenenvy** call-to-action; it contains no session IDs, project paths, prompts, refusal explanations, or other transcript content. Browser support determines whether **Share** can attach the image directly. **Copy image** and **Download PNG** remain available, with guided X, Bluesky, and LinkedIn composer fallbacks for manual posting.

Choose **Recap my week** for a separate **Week so far** image. It compares the current calendar week with your prior 28 days through a mix-adjusted personal Speed Index. It also shows the fastest and slowest measured days, aggregate request and session activity, output tokens, and the leading model family. The recap contains aggregate statistics only and carries Security Blueprints attribution alongside **Run your week · npx tokenenvy**.

Share actions use the public npm package page as their canonical product link. Release builders can override it at build time:

```bash
PUBLIC_TOKENENVY_URL=https://example.com/tokenenvy npm run build
```

The override must be a credential-free public `https://` URL. An invalid override is omitted rather than used.

## Development

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run check
npm test
npm run build
npm run test:package
```

`test:package` builds the npm tarball, installs it into a temporary empty project, exercises the installed `.bin`, scans fixtures from two transcript roots, and verifies authenticated access plus clean shutdown. The development server is loopback-only. Production access controls are enabled in the built Node server launched by the CLI. Tests and fixtures should use temporary transcript and state directories; do not point mutating test helpers at a real `~/.claude` directory.

## License

[Apache License 2.0](LICENSE). Copyright 2026 Niels Provos. See [NOTICE](NOTICE) for project attribution.
