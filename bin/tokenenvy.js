#!/usr/bin/env node

import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { unsupportedNodeMessage } from './node-version.js';

const DEFAULT_PORT = 4173;
const MAX_STDIN_BYTES = 1024 * 1024;

/** @typedef {{ usedPercentage: number, resetsAt: string }} QuotaWindow */
/** @typedef {{ fiveHour?: QuotaWindow, sevenDay?: QuotaWindow, model?: string, observedAt: string }} QuotaSample */
/** @typedef {'server' | 'statusline' | 'install-statusline'} CliCommand */
/** @typedef {{ command: CliCommand, logs: string[], port: number, timezone: string, open: boolean, rescan: boolean, help: boolean }} CliOptions */
/** @typedef {'installed' | 'missing' | 'foreign' | 'unknown'} StatuslineHookStateName */
/** @typedef {{ state: StatuslineHookStateName, settingsPath: string }} StatuslineHookState */
/** @typedef {'installed' | 'updated' | 'already-installed' | 'refused' | 'error'} InstallStatuslineStatus */
/** @typedef {{ status: InstallStatuslineStatus, settingsPath: string, command: string | null, message: string, npxCache?: boolean }} InstallStatuslineResult */
/** @typedef {{ env?: NodeJS.ProcessEnv, executablePath?: string }} InstallOptions */

export function stateDirectory(env = process.env) {
  if (env.TOKENENVY_DATA_DIR) return resolve(expandHome(env.TOKENENVY_DATA_DIR));
  return join(homedir(), '.tokenenvy');
}

/** Resolve the user-level Claude Code settings path, honoring CLAUDE_CONFIG_DIR. */
export function claudeSettingsPath(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) return join(resolve(env.CLAUDE_CONFIG_DIR), 'settings.json');
  return join(homedir(), '.claude', 'settings.json');
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
  return (
    within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within))
  );
}

/** Resolve, deduplicate, and remove nested roots without touching the filesystem. @param {string[]} values */
export function normalizeLogRoots(values) {
  const unique = [...new Set(values.map((value) => resolve(expandHome(value))))];
  return unique.filter(
    (candidate, index) =>
      !unique.some((root, rootIndex) => rootIndex !== index && containsPath(root, candidate)),
  );
}

function usage() {
  return `Token Envy: a private, local Claude Code performance dashboard

Usage:
  tokenenvy [--logs PATH]... [--port PORT] [--timezone ZONE] [--no-open] [--rescan]
  tokenenvy statusline
  tokenenvy install-statusline

Options:
  --logs PATH       Claude projects log root; repeat for more roots (default: ~/.claude/projects)
  --port PORT       Loopback HTTP port (default: ${DEFAULT_PORT})
  --timezone ZONE   IANA timezone for daily boundaries (default: system timezone)
  --no-open         Do not open the dashboard in a browser
  --rescan          Re-read live transcripts while preserving archived history
  -h, --help        Show this help

Commands:
  statusline            Read Claude Code status JSON on stdin (invoked by Claude Code)
  install-statusline    Install the statusLine hook into ~/.claude/settings.json
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
    help: false,
  };

  const args = [...argv];
  const subcommands = ['statusline', 'install-statusline'];
  if (typeof args[0] === 'string' && subcommands.includes(args[0])) {
    options.command = /** @type {CliCommand} */ (args.shift());
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--no-open') options.open = false;
    else if (arg === '--rescan') options.rescan = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--logs') options.logs.push(requiredValue(args, ++index, arg));
    else if (arg === '--port') options.port = parsePort(requiredValue(args, ++index, arg));
    else if (arg === '--timezone')
      options.timezone = parseTimezone(requiredValue(args, ++index, arg));
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (options.command === 'statusline' && args.length > 0) {
    throw new Error('The statusline command does not accept server options.');
  }
  if (options.command === 'install-statusline' && args.length > 0) {
    throw new Error('The install-statusline command does not accept options.');
  }
  options.logs = normalizeLogRoots(
    options.logs.length > 0 ? options.logs : [join(homedir(), '.claude', 'projects')],
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
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`Invalid port: ${value}`);
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

/**
 * Resolve the status-line command string from the entry point that is running right now.
 * Always an absolute, quoted path so a GUI-launched Claude Code with a minimal PATH still works.
 * @param {string} [executablePath]
 * @returns {{ command: string, npxCache: boolean } | null}
 */
function resolveStatuslineEntry(executablePath = process.argv[1]) {
  if (!executablePath) return null;
  let entryPath;
  try {
    if (lstatSync(executablePath).isSymbolicLink()) {
      // npm global installs invoke through a stable bin symlink; keep it as invoked so the
      // recorded hook survives in-place package upgrades.
      entryPath = resolve(executablePath);
    } else {
      const real = realpathSync(executablePath);
      const suffixes = [`${sep}bin${sep}launch.js`, `${sep}bin${sep}tokenenvy.js`];
      if (!suffixes.some((suffix) => real.endsWith(suffix))) return null;
      entryPath = real;
    }
  } catch {
    return null;
  }
  const npxCache = entryPath.includes('/_npx/') || entryPath.includes(`${sep}_npx${sep}`);
  const quoted = `"${entryPath}"`;
  const command =
    platform() === 'win32' ? `"${process.execPath}" ${quoted} statusline` : `${quoted} statusline`;
  return { command, npxCache };
}

/** Return the status-line command to install for the running entry point, or null. @param {string} [executablePath] */
export function statuslineCommand(executablePath = process.argv[1]) {
  const entry = resolveStatuslineEntry(executablePath);
  return entry ? entry.command : null;
}

/**
 * Report whether a status-line command string invokes the tokenenvy statusline helper.
 * Both a tokenenvy executable and a standalone statusline argument must appear.
 * @param {unknown} value
 */
export function isTokenenvyStatuslineCommand(value) {
  if (typeof value !== 'string') return false;
  const tokens = value.split(/[\s"'`;&|<>()$]+/).filter(Boolean);
  const invokesHelper = tokens.some((token) => {
    // Normalize Windows separators so both slash styles share the checks below.
    const normalized = token.replace(/\\/g, '/');
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
    return (
      ['tokenenvy', 'tokenenvy.js', 'tokenenvy.cmd', 'tokenenvy.exe', 'tokenenvy.ps1'].includes(
        basename,
      ) ||
      normalized.endsWith('/bin/launch.js') ||
      normalized.endsWith('/bin/tokenenvy.js')
    );
  });
  return invokesHelper && tokens.includes('statusline');
}

/** Detect the status-line hook without ever throwing on an unreadable settings file. @param {NodeJS.ProcessEnv} [env] @returns {StatuslineHookState} */
export function readStatuslineHookState(env = process.env) {
  const settingsPath = claudeSettingsPath(env);
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return { state: 'missing', settingsPath };
    return { state: 'unknown', settingsPath };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    return { state: 'unknown', settingsPath };
  const document = /** @type {Record<string, unknown>} */ (settings);
  if (document.statusLine === undefined) return { state: 'missing', settingsPath };
  if (typeof document.statusLine !== 'object' || document.statusLine === null)
    return { state: 'unknown', settingsPath };
  const command = /** @type {Record<string, unknown>} */ (document.statusLine).command;
  if (typeof command !== 'string') return { state: 'unknown', settingsPath };
  return {
    state: isTokenenvyStatuslineCommand(command) ? 'installed' : 'foreign',
    settingsPath,
  };
}

/** Install the statusLine hook into the user-level Claude Code settings file. @param {InstallOptions} [options] @returns {InstallStatuslineResult} */
export function installStatuslineHook({
  env = process.env,
  executablePath = process.argv[1],
} = {}) {
  const settingsPath = claudeSettingsPath(env);
  const entry = resolveStatuslineEntry(executablePath);
  if (!entry) {
    return {
      status: 'error',
      settingsPath,
      command: null,
      message:
        'Could not determine the tokenenvy executable path.\n' +
        `Add the statusLine entry to ${settingsPath} manually with "command": "tokenenvy statusline".`,
    };
  }

  let raw;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      return {
        status: 'error',
        settingsPath,
        command: entry.command,
        message:
          `Could not read ${settingsPath}. Token Envy left the file unchanged.\n` +
          'Fix or remove the file, then run `tokenenvy install-statusline` again.',
      };
    }
  }

  /** @type {Record<string, unknown>} */
  const settings = {};
  if (raw !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Parse failure leaves parsed undefined, caught below.
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        status: 'error',
        settingsPath,
        command: entry.command,
        message:
          `Could not parse ${settingsPath} as JSON. Token Envy left the file unchanged.\n` +
          'Fix or remove the file, then run `tokenenvy install-statusline` again.',
      };
    }
    Object.assign(settings, parsed);
  }

  /** @type {'installed' | 'updated'} */
  let outcome = 'installed';
  if (settings.statusLine !== undefined) {
    const statusLine = settings.statusLine;
    const record =
      typeof statusLine === 'object' && statusLine !== null && !Array.isArray(statusLine)
        ? /** @type {Record<string, unknown>} */ (statusLine)
        : null;
    if (
      record !== null &&
      typeof record.command === 'string' &&
      isTokenenvyStatuslineCommand(record.command) &&
      (record.type === undefined || record.type === 'command')
    ) {
      if (record.command === entry.command) {
        return {
          status: 'already-installed',
          settingsPath,
          command: entry.command,
          message: `The Token Envy status-line hook is already installed in ${settingsPath}.`,
        };
      }
      // A moved checkout or fresh npm link left the hook pointing at a dead path; repoint it.
      record.command = entry.command;
      outcome = 'updated';
    } else {
      return {
        status: 'refused',
        settingsPath,
        command: entry.command,
        message:
          `Refusing to modify ${settingsPath}: it already defines a statusLine command.\n` +
          'To measure rate limits, call the Token Envy helper from your existing command:\n' +
          `  ${entry.command}`,
      };
    }
  } else {
    settings.statusLine = { type: 'command', command: entry.command };
  }

  const directory = dirname(settingsPath);
  let mode = 0o600;
  try {
    mode = statSync(settingsPath).mode & 0o777;
  } catch {
    // Newly created settings files start private; existing modes are preserved.
  }
  const pendingPath = join(directory, `.settings-${randomBytes(8).toString('hex')}.tmp`);
  try {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(pendingPath, `${JSON.stringify(settings, null, 2)}\n`, { mode });
      // writeFileSync masks the mode with the process umask; chmod restores the preserved mode.
      chmodSync(pendingPath, mode);
      renameSync(pendingPath, settingsPath);
    } finally {
      try {
        unlinkSync(pendingPath);
      } catch {
        // The atomic rename already removed the temporary file.
      }
    }
  } catch (error) {
    return {
      status: 'error',
      settingsPath,
      command: entry.command,
      message: `Could not write ${settingsPath}: ${
        error instanceof Error ? error.message : String(error)
      }. The file was left unchanged.`,
    };
  }
  const note = entry.npxCache
    ? '\nNote: installed from an npx cache. Re-run this command after upgrading tokenenvy.'
    : '';
  if (outcome === 'updated') {
    return {
      status: outcome,
      settingsPath,
      command: entry.command,
      ...(entry.npxCache ? { npxCache: true } : {}),
      message:
        `Updated the Token Envy status-line hook in ${settingsPath}.\n` +
        `Command: ${entry.command}${note}`,
    };
  }
  return {
    status: 'installed',
    settingsPath,
    command: entry.command,
    ...(entry.npxCache ? { npxCache: true } : {}),
    message:
      `Installed the Token Envy status-line hook in ${settingsPath}.\n` +
      `Command: ${entry.command}\n` +
      `Restart Claude Code to activate rate-limit measurement.${note}`,
  };
}

/** @param {unknown} value @returns {QuotaWindow | null} */
function normalizeWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const item = /** @type {Record<string, unknown>} */ (value);
  const used = Number(item.used_percentage ?? item.usedPercentage);
  const rawReset = item.resets_at ?? item.resetsAt;
  if (!Number.isFinite(used) || used < 0 || used > 100 || rawReset == null) return null;

  let date;
  if (typeof rawReset === 'number')
    date = new Date(rawReset < 10_000_000_000 ? rawReset * 1000 : rawReset);
  else if (typeof rawReset === 'string') date = new Date(rawReset);
  else return null;
  if (!Number.isFinite(date.getTime())) return null;
  return { usedPercentage: used, resetsAt: date.toISOString() };
}

/**
 * Return only the two documented rate-limit windows plus the model id; all
 * other stdin fields are discarded. Quota systems differ per model, so the id
 * keeps samples from interleaving into one bucket.
 * @param {unknown} input
 * @param {Date} now
 * @returns {QuotaSample | null}
 */
export function extractRateLimits(input, now = new Date()) {
  if (!input || typeof input !== 'object') return null;
  const document = /** @type {Record<string, any>} */ (input);
  const limits =
    document.rate_limits ??
    document.rateLimits ??
    document.rate_limit ??
    document.usage?.rate_limits;
  if (!limits || typeof limits !== 'object') return null;

  const fiveHour = normalizeWindow(limits.five_hour ?? limits.fiveHour ?? limits.five_hour_window);
  const sevenDay = normalizeWindow(limits.seven_day ?? limits.sevenDay ?? limits.seven_day_window);
  if (!fiveHour && !sevenDay) return null;
  const model = typeof document.model?.id === 'string' ? document.model.id : null;
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(model ? { model } : {}),
    observedAt: now.toISOString(),
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
      if (!serverUrl || typeof connection.secret !== 'string')
        throw new Error('Invalid local server connection');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 150);
      try {
        await fetch(`${serverUrl}/api/v1/statusline`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(sample),
          signal: controller.signal,
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

/** Install the status-line hook; never starts the server or touches ~/.tokenenvy. @param {InstallOptions} [options] @returns {Promise<number>} */
export async function runInstallStatusline(options = {}) {
  const result = installStatuslineHook(options);
  const success = ['installed', 'updated', 'already-installed'].includes(result.status);
  const stream = success ? process.stdout : process.stderr;
  stream.write(`${result.message}\n`);
  return success ? 0 : 1;
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

/** Map the detected status-line hook state to the server startup notice. @param {NodeJS.ProcessEnv} [env] @returns {string[]} */
export function startupStatuslineLines(env = process.env) {
  const { state, settingsPath } = readStatuslineHookState(env);
  if (state === 'installed')
    return ['Status-line hook installed: rate-limit measurement is active.'];
  if (state === 'missing')
    return [
      'Rate-limit measurement is unavailable: the Claude Code status-line hook is not installed.',
      'Run `tokenenvy install-statusline` to install it.',
    ];
  if (state === 'foreign')
    return [
      `A different status-line command is configured in ${settingsPath}.`,
      'To measure rate limits, call the Token Envy helper from that command.',
    ];
  return [`Could not read ${settingsPath}; the status-line hook status is unknown.`];
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
    { mode: 0o600, flag: 'wx' },
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
    TOKENENVY_RESCAN: options.rescan ? '1' : '0',
  });

  const privateUrl = `${url}/?token=${encodeURIComponent(bootstrapToken)}`;
  process.stdout.write(`Token Envy is running at ${url}\n`);
  process.stdout.write(`Private dashboard URL: ${privateUrl}\n`);
  for (const line of startupStatuslineLines()) process.stdout.write(`${line}\n`);

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
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ERR_MODULE_NOT_FOUND'
    ) {
      throw new Error(
        'The production server is missing. Run `npm run build` before using this checkout.',
        { cause: error },
      );
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
  if (options.command === 'install-statusline') {
    process.exitCode = await runInstallStatusline({});
    return;
  }
  if (options.command === 'statusline') await runStatusline();
  else await runServer(options);
}

let invokedAsEntrypoint = false;
try {
  invokedAsEntrypoint = Boolean(
    process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href,
  );
} catch {
  // Importing the helper functions remains safe even when argv[1] disappeared.
}

if (invokedAsEntrypoint) {
  const versionError = unsupportedNodeMessage(process.versions.node);
  if (versionError) {
    process.stderr.write(versionError);
    process.exitCode = 1;
  } else {
    main().catch((error) => {
      process.stderr.write(
        `tokenenvy: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  }
}
