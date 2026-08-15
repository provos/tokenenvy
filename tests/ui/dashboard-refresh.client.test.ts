// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import DashboardRefreshHarness from './fixtures/DashboardRefreshHarness.svelte';

vi.mock('$env/dynamic/public', () => ({ env: {} }));

function click(target: ParentNode, testId: string) {
  const button = target.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`Missing ${testId}`);
  flushSync(() => button.click());
}

describe('selected-day background refresh', () => {
  it('retains the explicit day and hero through a transient missing series point', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(DashboardRefreshHarness, { target });

    try {
      click(target, 'load-r0');
      click(target, 'select-aug13');
      expect(target.querySelector('[data-testid="selected-date"]')?.textContent).toBe('2026-08-13');
      expect(target.textContent).toContain('64');

      click(target, 'refresh-r1');
      expect(target.querySelector('[data-testid="selected-date"]')?.textContent).toBe('2026-08-13');
      expect(target.textContent).toContain('64');
      expect(target.textContent).toContain('Updating in the background');
      expect(target.textContent).not.toContain('Loading this day');
      expect(target.textContent).not.toContain('Today selected');

      click(target, 'refresh-r2');
      expect(target.querySelector('[data-testid="selected-date"]')?.textContent).toBe('2026-08-13');
      expect(target.textContent).toContain('65');
      expect(target.textContent).not.toContain('Loading this day');

      click(target, 'range-change');
      expect(target.querySelector('[data-testid="selected-date"]')?.textContent).toBe('2026-08-14');
      expect(target.textContent).toContain('Loading this day');
    } finally {
      unmount(component);
      target.remove();
    }
  });

  it('selects Today when an ordinary revision supplies the first available data', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(DashboardRefreshHarness, { target });

    try {
      click(target, 'load-empty');
      expect(target.querySelector('[data-testid="selected-date"]')?.textContent).toBe('');
      expect(target.textContent).not.toContain('Loading this day');

      click(target, 'load-first-data');
      expect(target.querySelector('[data-testid="selected-date"]')?.textContent).toBe('2026-08-14');
      expect(target.textContent).toContain('70');
      expect(target.textContent).not.toContain('Loading this day');
    } finally {
      unmount(component);
      target.remove();
    }
  });
});
