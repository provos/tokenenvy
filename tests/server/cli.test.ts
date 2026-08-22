import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isSupportedNodeVersion } from '../../bin/node-version.js';
import { extractRateLimits, parseArgs, stateDirectory } from '../../bin/tokenenvy.js';

describe('CLI arguments', () => {
  it('runs when invoked through an npm-style bin symlink', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tokenenvy-bin-'));
    const executable = join(directory, 'tokenenvy');
    try {
      symlinkSync(resolve('bin/launch.js'), executable);
      const result = spawnSync(process.execPath, [executable, '--help'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Token Envy');
      expect(result.stdout).toContain('--no-open');
      expect(result.stdout).toContain('install-statusline');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stops unsupported Node versions before loading the CLI', () => {
    const launcher = pathToFileURL(resolve('bin/launch.js')).href;
    const script = [
      "Object.defineProperty(process.versions, 'node', { value: '20.19.0' });",
      `process.argv = [process.execPath, ${JSON.stringify(resolve('bin/launch.js'))}, '--help'];`,
      `await import(${JSON.stringify(launcher)});`,
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Token Envy requires Node.js 22.13 or newer.\n' +
        'Detected Node.js 20.19.0.\n' +
        'Upgrade Node.js, then run `npx tokenenvy` again.\n',
    );
  });

  it.each([
    ['20.19.0', false],
    ['22.12.9', false],
    ['22.13.0', true],
    ['22.99.0', true],
    ['23.0.0', true],
    ['', false],
    ['22.13', false],
    ['22.13.x', false],
    ['not-a-version', false],
    [undefined, false],
  ])('classifies Node version %s as supported: %s', (version, supported) => {
    expect(isSupportedNodeVersion(version)).toBe(supported);
  });

  it('guards direct CLI execution before server startup side effects', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tokenenvy-node-guard-'));
    const state = join(directory, 'state');
    const implementation = resolve('bin/tokenenvy.js');
    const script = [
      "Object.defineProperty(process.versions, 'node', { value: '20.19.0' });",
      `process.argv = [process.execPath, ${JSON.stringify(implementation)}, '--no-open'];`,
      `await import(${JSON.stringify(pathToFileURL(implementation).href)});`,
    ].join('\n');

    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        encoding: 'utf8',
        env: { ...process.env, TOKENENVY_DATA_DIR: state },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('requires Node.js 22.13 or newer');
      expect(existsSync(state)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('parses supported server flags', () => {
    const options = parseArgs([
      '--logs',
      '/tmp/claude-logs',
      '--logs',
      '/tmp/other-claude-logs',
      '--port',
      '4321',
      '--timezone',
      'America/Los_Angeles',
      '--no-open',
      '--rescan',
    ]);
    expect(options).toMatchObject({
      command: 'server',
      logs: ['/tmp/claude-logs', '/tmp/other-claude-logs'],
      port: 4321,
      timezone: 'America/Los_Angeles',
      open: false,
      rescan: true,
    });
  });

  it('uses the Claude projects root only when no explicit roots are provided', () => {
    expect(parseArgs([]).logs).toEqual([join(homedir(), '.claude', 'projects')]);
  });

  it('deduplicates roots and removes nested overlaps', () => {
    expect(
      parseArgs([
        '--logs',
        '/tmp/claude-logs/project',
        '--logs',
        '/tmp/claude-logs',
        '--logs',
        '/tmp/claude-logs',
        '--logs',
        '/tmp/other-logs',
      ]).logs,
    ).toEqual(['/tmp/claude-logs', '/tmp/other-logs']);
  });

  it('defaults state to ~/.tokenenvy and honors only the new override', () => {
    expect(stateDirectory({})).toBe(join(homedir(), '.tokenenvy'));
    expect(stateDirectory({ TOKENENVY_DATA_DIR: '/tmp/tokenenvy-state' })).toBe(
      '/tmp/tokenenvy-state',
    );
  });

  it.each([['--port', '0'], ['--port', '65536'], ['--timezone', 'Mars/Olympus'], ['--unknown']])(
    'rejects invalid input %s %s',
    (...args) => expect(() => parseArgs(args.filter(Boolean) as string[])).toThrow(),
  );
});

describe('status-line projection', () => {
  it('keeps only valid rate-limit windows and the model id', () => {
    const result = extractRateLimits(
      {
        session_id: 'private-session',
        transcript_path: '/private/path',
        model: { id: 'claude-fable-5', display_name: 'private-model' },
        rate_limits: {
          five_hour: { used_percentage: 12.4, resets_at: 1_800_000_000 },
          seven_day: { used_percentage: 54, resets_at: '2027-01-15T12:00:00Z' },
          private_window: { prompt: 'never include me' },
        },
      },
      new Date('2026-08-14T12:00:00Z'),
    );

    expect(result).toEqual({
      fiveHour: { usedPercentage: 12.4, resetsAt: '2027-01-15T08:00:00.000Z' },
      sevenDay: { usedPercentage: 54, resetsAt: '2027-01-15T12:00:00.000Z' },
      model: 'claude-fable-5',
      observedAt: '2026-08-14T12:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('omits the model field unless the payload carries a string id', () => {
    const base = {
      rate_limits: { seven_day: { used_percentage: 40, resets_at: '2027-01-15T12:00:00Z' } },
    };
    expect(extractRateLimits({ ...base, model: { display_name: 'Claude' } })).not.toHaveProperty(
      'model',
    );
    expect(extractRateLimits({ ...base, model: { id: 5 } })).not.toHaveProperty('model');
    expect(extractRateLimits({ ...base })).not.toHaveProperty('model');
  });

  it('drops malformed or out-of-range windows', () => {
    expect(
      extractRateLimits({
        rate_limits: { five_hour: { used_percentage: 101, resets_at: 'soon' } },
      }),
    ).toBeNull();
  });
});
