# Claude Speedometer

Claude Speedometer is a private, local-first performance dashboard for Claude Code. It continuously indexes performance metadata from Claude Code JSONL transcripts and turns it into model-by-model throughput trends, daily distributions, refusal outcomes, observed usage, and privacy-safe share cards.

It does not need an LLM, an Anthropic API key, telemetry, or an internet connection. The web server listens only on the loopback interface and the transcript directory is always read-only.

## What it shows

- Effective output tokens/s for Opus, Sonnet, Fable, Haiku, and other models
- Daily medians, interquartile ranges, sample sizes, and statistically eligible confidence intervals
- A 28-day mix-adjusted speed index that does not let today's model mix redefine its own baseline
- Drill-down histograms, hourly medians, exclusions, and data-quality counts
- Explicit classifier refusals split into attempted, recovered by fallback, user-visible, and unknown
- Observed weekly output and a projection based on the current week
- Optional five-hour and seven-day rate-limit percentages from Claude Code's local status-line payload
- Downloadable, privacy-safe share images with friendly or user-enabled spicy taglines

The spicy share tone is an explicit choice in the share dialog. Each dialog opens in the friendly default. Performance taglines are withheld when there is not enough current or baseline data to justify them.

## Install and run

Claude Speedometer requires Node.js 22.13 or newer.

After an npm release is published, it can be run with:

```bash
npx claude-speedometer
```

From this checkout:

```bash
npm install
npm run build
npm link
claude-speedometer
```

The CLI prints the loopback address and normally opens it in the default browser. The initial browser URL has a one-time random access token; a `SameSite=Strict`, HTTP-only cookie is used after that token is redeemed. A fresh token is created on every server launch.

By default, the scanner reads `~/.claude/projects/**/*.jsonl`. Point it at a replacement transcript root with `--logs`; it never broadens an explicit path into a crawl of the whole Claude directory.

```bash
claude-speedometer \
  --logs ~/.claude/projects \
  --port 4173 \
  --timezone America/Los_Angeles \
  --no-open
```

### CLI options

| Option | Meaning |
| --- | --- |
| `--logs PATH` | Replace the default `~/.claude/projects` transcript root |
| `--port PORT` | Listen on this loopback port; default is `4173` |
| `--timezone ZONE` | Use this IANA timezone for calendar-day boundaries |
| `--no-open` | Start without opening a browser |
| `--rescan` | Rebuild the derived index before scanning all transcripts |
| `-h`, `--help` | Print CLI help |

The watcher remains active while the server process runs. Stop it with Ctrl-C. The derived SQLite index and its pseudonymization key live in the OS user-state directory (`~/Library/Application Support/claude-speedometer` on macOS, `$XDG_STATE_HOME/claude-speedometer` on Linux). Set `CLAUDE_SPEEDOMETER_DATA_DIR` to override that location.

## Optional rate-limit display

Transcript totals are not an account quota: Claude web, Desktop, and Code may share limits, and the service decides the actual allowance. Claude Speedometer therefore labels transcript-only totals as **observed usage**.

Claude Code can provide current five-hour and seven-day percentages to a status-line command. To opt in, add a status-line command to your own Claude settings:

```json
{
  "statusLine": {
    "type": "command",
    "command": "claude-speedometer statusline"
  }
}
```

Claude Speedometer never creates or overwrites `~/.claude/settings.json`. If you already use a status-line command, integrate the helper into that command rather than replacing it blindly.

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

Open the share preview from the dashboard, choose the friendly or spicy tone, and export the generated PNG. The card contains aggregate statistics, the mix-adjusted comparison, a bounded 14-day trend, and Claude Speedometer attribution; it contains no session IDs, project paths, prompts, or other transcript content. Browser support determines whether **Share** can attach the image directly. **Copy image** and **Download PNG** remain available for manual posting.

Release builders can add a canonical product link to share cards and social composers at build time:

```bash
PUBLIC_CLAUDE_SPEEDOMETER_URL=https://example.com/claude-speedometer npm run build
```

The value must be a public `https://` URL. When it is unset or invalid, the card keeps the Claude Speedometer name but omits the link. This checkout does not claim an npm URL before the package is published.

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

`test:package` builds the npm tarball, installs it into a temporary empty project, exercises the installed `.bin`, and starts a fixture-backed server through its health check. The development server is loopback-only. Production access controls are enabled in the built Node server launched by the CLI. Tests and fixtures should use temporary transcript and state directories; do not point mutating test helpers at a real `~/.claude` directory.

## License

[MIT](LICENSE)
