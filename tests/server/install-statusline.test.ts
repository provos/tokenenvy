import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeSettingsPath,
  installStatuslineHook,
  isTokenenvyStatuslineCommand,
  parseArgs,
  readStatuslineHookState,
  startupStatuslineLines,
  statuslineCommand,
} from '../../bin/tokenenvy.js';

const checkoutEntry = resolve('bin/launch.js');

describe('install-statusline arguments', () => {
  it('parses the subcommand without disturbing server defaults', () => {
    expect(parseArgs(['install-statusline'])).toMatchObject({
      command: 'install-statusline',
      port: 4173,
      open: true,
      rescan: false,
      help: false,
    });
  });

  it.each([['--port'], ['4321'], ['--no-open']])('rejects extra argument %s', (arg) => {
    expect(() => parseArgs(['install-statusline', arg])).toThrow();
  });
});

describe('status-line command composition', () => {
  it('records an npm-style bin symlink as invoked instead of its realpath', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tokenenvy-link-'));
    const link = join(directory, 'tokenenvy');
    try {
      symlinkSync(resolve('bin/launch.js'), link);
      expect(statuslineCommand(link)).toBe(`"${link}" statusline`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records the realpath of a direct checkout entry point', () => {
    const entry = resolve('bin/tokenenvy.js');
    expect(statuslineCommand(entry)).toBe(`"${realpathSync(entry)}" statusline`);
  });

  it('quotes entry point paths that contain spaces', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tokenenvy-spaces-'));
    try {
      const tools = join(directory, 'My Tools');
      mkdirSync(tools);
      const link = join(tools, 'tokenenvy');
      symlinkSync(resolve('bin/launch.js'), link);
      expect(statuslineCommand(link)).toBe(`"${link}" statusline`);
      expect(statuslineCommand(link)).toContain('My Tools/tokenenvy" statusline');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns null for paths that are not the tokenenvy entry point', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tokenenvy-unrelated-'));
    try {
      const unrelated = join(directory, 'unrelated.js');
      writeFileSync(unrelated, 'console.log("nope");\n');
      expect(statuslineCommand(join(directory, 'missing.js'))).toBeNull();
      expect(statuslineCommand(unrelated)).toBeNull();
      expect(statuslineCommand('')).toBeNull();
      expect(statuslineCommand(undefined)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('resolves the settings path from CLAUDE_CONFIG_DIR or the home directory', () => {
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: '/tmp/claude-config' })).toBe(
      '/tmp/claude-config/settings.json',
    );
    expect(claudeSettingsPath({})).toBe(join(homedir(), '.claude', 'settings.json'));
  });
});

describe('status-line detection', () => {
  it.each([
    ['tokenenvy statusline', true],
    ['"/usr/local/bin/tokenenvy" statusline', true],
    ['"/Users/x/src/app/bin/launch.js" statusline', true],
    ['"/Users/x/src/app/bin/tokenenvy.js" statusline', true],
    ['"C:\\node.exe" "C:\\Users\\x\\app\\bin\\launch.js" statusline', true],
    ['"C:\\node.exe" "C:\\Users\\x\\app\\bin\\launch.js"', false],
    ["bash -c 'tokenenvy statusline; starship'", true],
    ['starship', false],
    ['npx tokenenvy', false],
    ['./scripts/launch.js dev', false],
    ['tokenenvy statusline-report', false],
  ])('classifies %s as a tokenenvy hook: %s', (command, expected) => {
    expect(isTokenenvyStatuslineCommand(command)).toBe(expected);
  });

  it('reads the hook state without ever throwing', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-state-'));
    const env = { CLAUDE_CONFIG_DIR: home };
    const settingsPath = join(home, 'settings.json');
    try {
      expect(readStatuslineHookState(env)).toEqual({
        state: 'missing',
        settingsPath,
      });
      writeFileSync(settingsPath, '{"model":"opus"}\n');
      expect(readStatuslineHookState(env).state).toBe('missing');
      writeFileSync(
        settingsPath,
        '{"statusLine":{"type":"command","command":"tokenenvy statusline"}}\n',
      );
      expect(readStatuslineHookState(env).state).toBe('installed');
      writeFileSync(settingsPath, '{ oops');
      expect(readStatuslineHookState(env).state).toBe('unknown');
      writeFileSync(settingsPath, '{"statusLine":"builtin"}\n');
      expect(readStatuslineHookState(env).state).toBe('unknown');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('status-line installation', () => {
  it('creates a private settings file when it does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-install-'));
    const env = { CLAUDE_CONFIG_DIR: join(home, 'claude-config') };
    const settingsPath = join(home, 'claude-config', 'settings.json');
    try {
      const result = installStatuslineHook({ env, executablePath: checkoutEntry });
      expect(result.status).toBe('installed');
      expect(result.message).toContain(
        `Installed the Token Envy status-line hook in ${settingsPath}`,
      );
      const expected = `${JSON.stringify(
        { statusLine: { type: 'command', command: result.command } },
        null,
        2,
      )}\n`;
      expect(readFileSync(settingsPath, 'utf8')).toBe(expected);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('appends statusLine while preserving other keys and their order', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-install-'));
    const env = { CLAUDE_CONFIG_DIR: home };
    const settingsPath = join(home, 'settings.json');
    const before = `${JSON.stringify(
      { model: 'opus', permissions: { allow: ['Bash(ls)'] } },
      null,
      2,
    )}\n`;
    try {
      writeFileSync(settingsPath, before);
      const result = installStatuslineHook({ env, executablePath: checkoutEntry });
      expect(result.status).toBe('installed');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(Object.keys(settings)).toEqual(['model', 'permissions', 'statusLine']);
      expect(settings.model).toBe('opus');
      expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
      expect(settings.statusLine).toEqual({ type: 'command', command: result.command });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ['a foreign command', { statusLine: { type: 'command', command: 'starship' } }],
    ['a non-command type', { statusLine: { type: 'vscode', command: 'tokenenvy statusline' } }],
    ['a non-object statusLine', { statusLine: 'builtin' }],
    ['a missing command', { statusLine: { type: 'command' } }],
  ])('refuses to replace an existing statusLine with %s', (_description, existing) => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-install-'));
    const env = { CLAUDE_CONFIG_DIR: home };
    const settingsPath = join(home, 'settings.json');
    const before = `${JSON.stringify(existing, null, 2)}\n`;
    try {
      writeFileSync(settingsPath, before);
      const result = installStatuslineHook({ env, executablePath: checkoutEntry });
      expect(result.status).toBe('refused');
      expect(result.message).toContain(`Refusing to modify ${settingsPath}`);
      expect(result.message).toContain('To measure rate limits');
      expect(readFileSync(settingsPath, 'utf8')).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is idempotent when the hook is already installed', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-install-'));
    const env = { CLAUDE_CONFIG_DIR: home };
    const settingsPath = join(home, 'settings.json');
    try {
      const first = installStatuslineHook({ env, executablePath: checkoutEntry });
      expect(first.status).toBe('installed');
      const contents = readFileSync(settingsPath, 'utf8');
      const second = installStatuslineHook({ env, executablePath: checkoutEntry });
      expect(second.status).toBe('already-installed');
      expect(second.message).toBe(
        `The Token Envy status-line hook is already installed in ${settingsPath}.`,
      );
      expect(readFileSync(settingsPath, 'utf8')).toBe(contents);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('updates the recorded command when the executable moves and preserves other keys', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-install-'));
    const env = { CLAUDE_CONFIG_DIR: home };
    const settingsPath = join(home, 'settings.json');
    const firstDirectory = mkdtempSync(join(tmpdir(), 'tokenenvy-link-'));
    const secondDirectory = mkdtempSync(join(tmpdir(), 'tokenenvy-link-'));
    const firstLink = join(firstDirectory, 'tokenenvy');
    const secondLink = join(secondDirectory, 'tokenenvy');
    try {
      symlinkSync(resolve('bin/launch.js'), firstLink);
      symlinkSync(resolve('bin/launch.js'), secondLink);
      writeFileSync(settingsPath, `${JSON.stringify({ model: 'opus' }, null, 2)}\n`);
      const first = installStatuslineHook({ env, executablePath: firstLink });
      expect(first.status).toBe('installed');
      const second = installStatuslineHook({ env, executablePath: secondLink });
      expect(second.status).toBe('updated');
      expect(second.message).toContain(
        `Updated the Token Envy status-line hook in ${settingsPath}.`,
      );
      expect(second.message).toContain(`Command: ${second.command}`);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(Object.keys(settings)).toEqual(['model', 'statusLine']);
      expect(settings.model).toBe('opus');
      expect(settings.statusLine).toEqual({ type: 'command', command: second.command });
      expect(settings.statusLine.command).not.toBe(first.command);
      const third = installStatuslineHook({ env, executablePath: secondLink });
      expect(third.status).toBe('already-installed');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(firstDirectory, { recursive: true, force: true });
      rmSync(secondDirectory, { recursive: true, force: true });
    }
  });

  it('preserves an existing settings file mode under a restrictive umask', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-install-'));
    const env = { CLAUDE_CONFIG_DIR: home };
    const settingsPath = join(home, 'settings.json');
    try {
      writeFileSync(settingsPath, `${JSON.stringify({ model: 'opus' }, null, 2)}\n`);
      chmodSync(settingsPath, 0o644);
      const previousUmask = process.umask(0o077);
      try {
        const result = installStatuslineHook({ env, executablePath: checkoutEntry });
        expect(result.status).toBe('installed');
        expect(statSync(settingsPath).mode & 0o777).toBe(0o644);
      } finally {
        process.umask(previousUmask);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('leaves an unparsable settings file untouched and writes no temporary files', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-install-'));
    const env = { CLAUDE_CONFIG_DIR: home };
    const settingsPath = join(home, 'settings.json');
    try {
      writeFileSync(settingsPath, '{ oops');
      const result = installStatuslineHook({ env, executablePath: checkoutEntry });
      expect(result.status).toBe('error');
      expect(result.message).toContain(
        `Could not parse ${settingsPath} as JSON. Token Envy left the file unchanged.`,
      );
      expect(readFileSync(settingsPath, 'utf8')).toBe('{ oops');
      expect(readdirSync(home)).toEqual(['settings.json']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports an unreadable settings file instead of claiming a parse failure', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-install-'));
    const config = join(home, 'claude-config');
    const env = { CLAUDE_CONFIG_DIR: config };
    const settingsPath = join(config, 'settings.json');
    try {
      mkdirSync(settingsPath, { recursive: true });
      const result = installStatuslineHook({ env, executablePath: checkoutEntry });
      expect(result.status).toBe('error');
      expect(result.message).toContain(`Could not read ${settingsPath}`);
      expect(result.message).toContain(
        'Fix or remove the file, then run `tokenenvy install-statusline` again.',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('aborts before touching settings when the executable path is unresolvable', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-install-'));
    const env = { CLAUDE_CONFIG_DIR: join(home, 'claude-config') };
    try {
      const result = installStatuslineHook({
        env,
        executablePath: join(home, 'unrelated.js'),
      });
      expect(result.status).toBe('error');
      expect(result.command).toBeNull();
      expect(result.message).toContain('Could not determine the tokenenvy executable path.');
      expect(existsSync(join(home, 'claude-config'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('round-trips with the startup detection', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-install-'));
    const env = { CLAUDE_CONFIG_DIR: home };
    try {
      installStatuslineHook({ env, executablePath: checkoutEntry });
      expect(readStatuslineHookState(env).state).toBe('installed');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('status-line startup notices', () => {
  it('reports the missing hook with the install command', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-startup-'));
    const env = { CLAUDE_CONFIG_DIR: home };
    try {
      expect(startupStatuslineLines(env)).toEqual([
        'Rate-limit measurement is unavailable: the Claude Code status-line hook is not installed.',
        'Run `tokenenvy install-statusline` to install it.',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('confirms an installed hook', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-startup-'));
    const env = { CLAUDE_CONFIG_DIR: home };
    const settingsPath = join(home, 'settings.json');
    try {
      writeFileSync(
        settingsPath,
        '{"statusLine":{"type":"command","command":"tokenenvy statusline"}}\n',
      );
      expect(startupStatuslineLines(env)).toEqual([
        'Status-line hook installed: rate-limit measurement is active.',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports an unreadable settings file without failing', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-startup-'));
    const env = { CLAUDE_CONFIG_DIR: home };
    const settingsPath = join(home, 'settings.json');
    try {
      writeFileSync(settingsPath, '{ oops');
      expect(startupStatuslineLines(env)).toEqual([
        `Could not read ${settingsPath}; the status-line hook status is unknown.`,
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('describes a foreign status-line command without suggesting installation', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenenvy-startup-'));
    const env = { CLAUDE_CONFIG_DIR: home };
    const settingsPath = join(home, 'settings.json');
    try {
      writeFileSync(settingsPath, '{"statusLine":{"type":"command","command":"starship"}}\n');
      expect(readStatuslineHookState(env)).toEqual({ state: 'foreign', settingsPath });
      const lines = startupStatuslineLines(env);
      expect(lines).toEqual([
        `A different status-line command is configured in ${settingsPath}.`,
        'To measure rate limits, call the Token Envy helper from that command.',
      ]);
      expect(lines.join('\n')).not.toContain('install-statusline');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
