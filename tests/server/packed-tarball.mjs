#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const work = mkdtempSync(join(tmpdir(), 'tokenenvy-pack-'));
const packageDirectory = join(work, 'consumer');
const firstLogsDirectory = join(work, 'logs-a');
const secondLogsDirectory = join(work, 'logs-b');
const stateDirectory = join(work, 'state');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}

async function unusedPort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not reserve a test port'));
      probe.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Installed server exited early with status ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json()).service === 'tokenenvy') return;
    } catch {
      // Startup commonly needs a few polling intervals.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Installed server did not become healthy within 15 seconds');
}

async function waitForScanner(url, cookie, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Installed server exited early with status ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/v1/overview`, {
        headers: { cookie },
        signal: AbortSignal.timeout(500)
      });
      if (response.ok) {
        const overview = await response.json();
        if (overview.scan?.state === 'idle' && overview.scan.filesDiscovered === 2) return overview;
      }
    } catch {
      // The scanner initializes in the background.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Installed server did not scan both configured transcript roots within 15 seconds');
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  return new Promise((resolveExit) => {
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolveExit(null);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function forceStop(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 2_000)) return;
  child.kill('SIGKILL');
  await waitForExit(child, 2_000);
}

mkdirSync(packageDirectory);
mkdirSync(firstLogsDirectory);
mkdirSync(secondLogsDirectory);
mkdirSync(stateDirectory);
writeFileSync(join(firstLogsDirectory, 'first.jsonl'), '{}\n');
writeFileSync(join(secondLogsDirectory, 'second.jsonl'), '{}\n');

let server;
try {
  run('npm', ['run', 'build']);
  const packResult = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work]));
  const packed = packResult[0];
  const names = packed.files.map(({ path }) => path);
  for (const required of [
    'package.json',
    'README.md',
    'LICENSE',
    'NOTICE',
    'bin/launch.js',
    'bin/node-version.js',
    'bin/tokenenvy.js',
    'build/index.js'
  ]) {
    if (!names.includes(required)) throw new Error(`Packed package is missing ${required}`);
  }
  for (const privateOrLegacy of ['REPORT.md', 'analyze-claude-logs.mjs', 'throughput-histogram.csv']) {
    if (names.includes(privateOrLegacy)) throw new Error(`Packed package unexpectedly contains ${privateOrLegacy}`);
  }

  const tarball = join(work, packed.filename);
  run('npm', ['init', '--yes'], { cwd: packageDirectory });
  run('npm', ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: packageDirectory });

  const installedRoot = join(packageDirectory, 'node_modules', 'tokenenvy');
  const manifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
  if (manifest.license !== 'Apache-2.0' || manifest.author !== 'Niels Provos') {
    throw new Error('Packed package metadata does not identify the Apache license and copyright owner');
  }
  const license = readFileSync(join(installedRoot, 'LICENSE'), 'utf8');
  if (!license.includes('Grant of Patent License') || license.includes('% Total') || license.includes('\r')) {
    throw new Error('Packed Apache license is incomplete or contains transfer output');
  }
  const notice = readFileSync(join(installedRoot, 'NOTICE'), 'utf8');
  if (!notice.includes('Copyright 2026 Niels Provos') || !notice.includes('Security Blueprints, LLC')) {
    throw new Error('Packed NOTICE is missing the copyright or project attribution');
  }

  const executable = join(packageDirectory, 'node_modules', '.bin', 'tokenenvy');
  const installedLauncher = join(packageDirectory, 'node_modules', 'tokenenvy', 'bin', 'launch.js');
  const unsupportedScript = [
    "Object.defineProperty(process.versions, 'node', { value: '20.19.0' });",
    `process.argv = [process.execPath, ${JSON.stringify(executable)}, '--help'];`,
    `await import(${JSON.stringify(pathToFileURL(installedLauncher).href)});`
  ].join('\n');
  const unsupported = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', unsupportedScript],
    { cwd: packageDirectory, encoding: 'utf8' }
  );
  if (
    unsupported.status !== 1 ||
    unsupported.stdout !== '' ||
    !unsupported.stderr.includes('requires Node.js 22.13 or newer') ||
    unsupported.stderr.includes('Token Envy is running')
  ) {
    throw new Error(`Installed CLI did not reject Node.js 20 before startup:\n${unsupported.stderr}`);
  }

  const help = run(executable, ['--help'], { cwd: packageDirectory });
  if (!help.includes('--logs PATH') || !help.includes('statusline')) throw new Error('Installed CLI help is incomplete');

  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  server = spawn(
    executable,
    [
      '--logs',
      firstLogsDirectory,
      '--logs',
      secondLogsDirectory,
      '--port',
      String(port),
      '--timezone',
      'UTC',
      '--no-open'
    ],
    {
      cwd: packageDirectory,
      env: { ...process.env, TOKENENVY_DATA_DIR: stateDirectory },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  let serverOutput = '';
  server.stdout.on('data', (chunk) => (serverOutput += chunk.toString('utf8')));
  server.stderr.on('data', (chunk) => (serverOutput += chunk.toString('utf8')));
  await waitForHealth(url, server);

  const privateUrl = serverOutput.match(/Private dashboard URL: (\S+)/)?.[1];
  if (!privateUrl) throw new Error(`Installed CLI did not print its private dashboard URL:\n${serverOutput}`);
  const bootstrap = await fetch(privateUrl, { redirect: 'manual' });
  const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
  if (bootstrap.status !== 303 || !cookie || bootstrap.headers.get('location') !== '/') {
    throw new Error('Installed server did not complete its production bootstrap handshake');
  }
  const dashboard = await fetch(url, { headers: { cookie } });
  if (!dashboard.ok || !(await dashboard.text()).includes('Token Envy')) {
    throw new Error('Installed server did not accept its production session cookie');
  }
  await waitForScanner(url, cookie, server);

  const connection = JSON.parse(readFileSync(join(stateDirectory, 'server.json'), 'utf8'));
  if (connection.url !== url || typeof connection.secret !== 'string') {
    throw new Error('Installed CLI did not write a usable local status-line connection');
  }

  server.kill('SIGTERM');
  const shutdown = await waitForExit(server, 5_000);
  if (!shutdown) {
    await forceStop(server);
    throw new Error('Installed server did not exit within 5 seconds of SIGTERM');
  }
  if (shutdown.code !== 0) {
    throw new Error(`Installed server exited uncleanly after SIGTERM (${shutdown.signal ?? shutdown.code})`);
  }

  process.stdout.write(
    `Packed ${packed.filename}, installed its bin, scanned two roots, and shut it down cleanly.\n`
  );
} finally {
  if (server) await forceStop(server);
  rmSync(work, { recursive: true, force: true });
}
