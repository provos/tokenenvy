import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { extractRateLimits, parseArgs } from '../../bin/claude-speedometer.js';

describe('CLI arguments', () => {
  it('runs when invoked through an npm-style bin symlink', () => {
    const directory = mkdtempSync(join(tmpdir(), 'speedometer-bin-'));
    const executable = join(directory, 'claude-speedometer');
    try {
      symlinkSync(resolve('bin/claude-speedometer.js'), executable);
      const result = spawnSync(process.execPath, [executable, '--help'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Claude Speedometer');
      expect(result.stdout).toContain('--no-open');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('parses supported server flags', () => {
    const options = parseArgs([
      '--logs',
      '/tmp/claude-logs',
      '--port',
      '4321',
      '--timezone',
      'America/Los_Angeles',
      '--no-open',
      '--rescan'
    ]);
    expect(options).toMatchObject({
      command: 'server',
      logs: '/tmp/claude-logs',
      port: 4321,
      timezone: 'America/Los_Angeles',
      open: false,
      rescan: true
    });
  });

  it.each([['--port', '0'], ['--port', '65536'], ['--timezone', 'Mars/Olympus'], ['--unknown']])(
    'rejects invalid input %s %s',
    (...args) => expect(() => parseArgs(args.filter(Boolean) as string[])).toThrow()
  );
});

describe('status-line projection', () => {
  it('keeps only valid rate-limit windows', () => {
    const result = extractRateLimits(
      {
        session_id: 'private-session',
        transcript_path: '/private/path',
        model: { display_name: 'private-model' },
        rate_limits: {
          five_hour: { used_percentage: 12.4, resets_at: 1_800_000_000 },
          seven_day: { used_percentage: 54, resets_at: '2027-01-15T12:00:00Z' },
          private_window: { prompt: 'never include me' }
        }
      },
      new Date('2026-08-14T12:00:00Z')
    );

    expect(result).toEqual({
      fiveHour: { usedPercentage: 12.4, resetsAt: '2027-01-15T08:00:00.000Z' },
      sevenDay: { usedPercentage: 54, resetsAt: '2027-01-15T12:00:00.000Z' },
      observedAt: '2026-08-14T12:00:00.000Z'
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('drops malformed or out-of-range windows', () => {
    expect(extractRateLimits({ rate_limits: { five_hour: { used_percentage: 101, resets_at: 'soon' } } })).toBeNull();
  });
});
