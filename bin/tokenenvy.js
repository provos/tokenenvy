#!/usr/bin/env node

import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const DEFAULT_PORT = 4173;
const MAX_STDIN_BYTES = 1024 * 1024;

/** @typedef {{ usedPercentage: number, resetsAt: string }} QuotaWindow */
/** @typedef {{ fiveHour?: QuotaWindow, sevenDay?: QuotaWindow, observedAt: string }} QuotaSample */
/** @typedef {{ command: string, logs: string[], port: number, timezone: string, open: boolean, rescan: boolean, help: boolean }} CliOptions */

export function stateDirectory(env = process.env) {
  if (env.TOKENENVY_DATA_DIR) return resolve(expandHome(env.TOKENENVY_DATA_DIR));
  return join(homedir(), '.tokenenvy');
}

/** @param {string} value */
function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/** @param {string} root @param {string} candidate */
function containsPath(root, candidate) {
  const within = relative(root, candidate);
  return within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within));
}

/** Resolve, deduplicate, and remove nested roots without touching the filesystem. @param {string[]} values */
export function normalizeLogRoots(values) {
  const unique = [...new Set(values.map((value) => resolve(expandHome(value))))];
  return unique.filter((candidate, index) =>
    !unique.some((root, rootIndex) => rootIndex !== index && containsPath(root, candidate))
  );
}

function usage() {
  return `Token Envy — a private, local Claude Code performance dashboard

Usage:
  tokenenvy [--logs PATH]... [--port PORT] [--timezone ZONE] [--no-open] [--rescan]
  tokenenvy statusline

Options:
  --logs PATH       Claude projects log root; repeat for more roots (default: ~/.claude/projects)
  --port PORT       Loopback HTTP port (default: ${DEFAULT_PORT})
  --timezone ZONE   IANA timezone for daily boundaries (default: system timezone)
  --no-open         Do not open the dashboard in a browser
  --rescan          Re-read live transcripts while preserving archived history
  -h, --help        Show this help
`;
}

/** @param {string[]} argv @returns {CliOptions} */
export function parseArgs(argv) {
  /** @type {CliOptions} */
  const options = {
    command: 'server',
    logs: [],
    port: DEFAULT_PORT,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    open: true,
    rescan: false,
    help: false
  };

  const args = [...argv];
  if (args[0] === 'statusline') {
    options.command = 'statusline';
    args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--no-open') options.open = false;
    else if (arg === '--rescan') options.rescan = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--logs') options.logs.push(requiredValue(args, ++index, arg));
    else if (arg === '--port') options.port = parsePort(requiredValue(args, ++index, arg));
    else if (arg === '--timezone') options.timezone = parseTimezone(requiredValue(args, ++index, arg));
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (options.command === 'statusline' && args.length > 0) {
    throw new Error('The statusline command does not accept server options.');
  }
  options.logs = normalizeLogRoots(
    options.logs.length > 0 ? options.logs : [join(homedir(), '.claude', 'projects')]
  );
  return options;
}

/** @param {string[]} args @param {number} index @param {string} option */
function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

/** @param {string} value */
function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid port: ${value}`);
  return port;
}

/** @param {string} value */
function parseTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return value;
  } catch {
    throw new Error(`Invalid IANA timezone: ${value}`);
  }
}

/** @param {unknown} value @returns {QuotaWindow | null} */
function normalizeWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const item = /** @type {Record<string, unknown>} */ (value);
  const used = Number(item.used_percentage ?? item.usedPercentage);
  const rawReset = item.resets_at ?? item.resetsAt;
  if (!Number.isFinite(used) || used < 0 || used > 100 || rawReset == null) return null;

  let date;
  if (typeof rawReset === 'number') date = new Date(rawReset < 10_000_000_000 ? rawReset * 1000 : rawReset);
  else if (typeof rawReset === 'string') date = new Date(rawReset);
  else return null;
  if (!Number.isFinite(date.getTime())) return null;
  return { usedPercentage: used, resetsAt: date.toISOString() };
}

/**
 * Return only the two documented rate-limit windows; all other stdin fields are discarded.
 * @param {unknown} input
 * @param {Date} now
 * @returns {QuotaSample | null}
 */
export function extractRateLimits(input, now = new Date()) {
  if (!input || typeof input !== 'object') return null;
  const document = /** @type {Record<string, any>} */ (input);
  const limits = document.rate_limits ?? document.rateLimits ?? document.rate_limit ?? document.usage?.rate_limits;
  if (!limits || typeof limits !== 'object') return null;

  const fiveHour = normalizeWindow(limits.five_hour ?? limits.fiveHour ?? limits.five_hour_window);
  const sevenDay = normalizeWindow(limits.seven_day ?? limits.sevenDay ?? limits.seven_day_window);
  if (!fiveHour && !sevenDay) return null;
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    observedAt: now.toISOString()
  };
}

/** @param {unknown} value */
function loopbackServerUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:') return null;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error('Status-line input is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** @param {QuotaSample | null} sample */
function statusText(sample) {
  const parts = [];
  if (sample?.fiveHour) parts.push(`5h ${Math.round(sample.fiveHour.usedPercentage)}%`);
  if (sample?.sevenDay) parts.push(`7d ${Math.round(sample.sevenDay.usedPercentage)}%`);
  return parts.length ? `Claude ${parts.join(' · ')}` : '';
}

export async function runStatusline() {
  let sample = null;
  try {
    sample = extractRateLimits(JSON.parse(await readStdin()));
  } catch {
    // A status-line helper must never interfere with Claude Code itself.
  }

  if (sample) {
    try {
      const connection = JSON.parse(readFileSync(join(stateDirectory(), 'server.json'), 'utf8'));
      const serverUrl = loopbackServerUrl(connection.url);
      if (!serverUrl || typeof connection.secret !== 'string') throw new Error('Invalid local server connection');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 150);
      try {
        await fetch(`${serverUrl}/api/v1/statusline`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.secret}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(sample),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Missing/stopped dashboard and short timeouts are intentionally silent.
    }
  }

  const text = statusText(sample);
  if (text) process.stdout.write(text);
}

/** @param {number} port */
async function assertPortAvailable(port) {
  await new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolvePromise));
  });
}

/** @param {string} url */
function openBrowser(url) {
  const command = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.once('error', () => {});
  child.unref();
}

/** @param {CliOptions} options */
export async function runServer(options) {
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'index.js');
  await assertPortAvailable(options.port);

  const bootstrapToken = randomBytes(32).toString('base64url');
  const statuslineSecret = randomBytes(32).toString('base64url');
  const url = `http://127.0.0.1:${options.port}`;
  const directory = stateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const connectionPath = join(directory, 'server.json');
  const pendingConnectionPath = join(directory, `.server-${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(
    pendingConnectionPath,
    `${JSON.stringify({ url, secret: statuslineSecret, pid: process.pid, writtenAt: new Date().toISOString() })}\n`,
    { mode: 0o600, flag: 'wx' }
  );
  renameSync(pendingConnectionPath, connectionPath);

  Object.assign(process.env, {
    HOST: '127.0.0.1',
    PORT: String(options.port),
    ORIGIN: url,
    NODE_ENV: 'production',
    TOKENENVY_LOGS: JSON.stringify(options.logs),
    TOKENENVY_TIMEZONE: options.timezone,
    TOKENENVY_DATA_DIR: directory,
    TOKENENVY_BOOTSTRAP_TOKEN: bootstrapToken,
    TOKENENVY_STATUSLINE_SECRET: statuslineSecret,
    TOKENENVY_RESCAN: options.rescan ? '1' : '0'
  });

  const privateUrl = `${url}/?token=${encodeURIComponent(bootstrapToken)}`;
  process.stdout.write(`Token Envy is running at ${url}\n`);
  process.stdout.write(`Private dashboard URL: ${privateUrl}\n`);
  process.stdout.write(`Status-line setup: ${process.argv[1]} statusline\n`);

  if (options.open) setTimeout(() => openBrowser(privateUrl), 250);

  const cleanup = () => {
    try {
      const current = JSON.parse(readFileSync(connectionPath, 'utf8'));
      if (current.pid === process.pid) unlinkSync(connectionPath);
    } catch {
      // The file may already be gone or belong to a replacement server.
    }
  };
  process.once('exit', cleanup);

  try {
    await import(pathToFileURL(entry).href);
  } catch (error) {
    cleanup();
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('The production server is missing. Run `npm run build` before using this checkout.');
    }
    throw error;
  }
}

/** @param {string[]} argv */
export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.command === 'statusline') await runStatusline();
  else await runServer(options);
}

let invokedAsEntrypoint = false;
try {
  invokedAsEntrypoint = Boolean(
    process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  );
} catch {
  // Importing the helper functions remains safe even when argv[1] disappeared.
}

if (invokedAsEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`tokenenvy: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
