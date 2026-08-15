import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DAILY_SHARE_CARD_LAYOUT,
  fitTextLines,
  shareCardLayoutStyle,
} from '../../src/lib/components/share-layout';

const appCss = readFileSync(new URL('../../src/app.css', import.meta.url), 'utf8');

describe('daily share-card layout', () => {
  it('keeps copy, comparison, activity, and footer in protected vertical bands', () => {
    const layout = DAILY_SHARE_CARD_LAYOUT;

    expect(layout.width / layout.height).toBeCloseTo(1200 / 630);
    expect(layout.header.bottom).toBeLessThan(layout.headline.top);
    expect(layout.headline.bottom).toBeLessThan(layout.comparison.top);
    expect(layout.comparison.bottom).toBeLessThan(layout.activity.top);
    expect(layout.activity.bottom).toBeLessThan(layout.footer.top);
    expect(layout.footer.bottom).toBeLessThanOrEqual(layout.height - layout.inset);
    expect(shareCardLayoutStyle()).toContain('--card-footer-bottom:');
  });

  it('fits a long headline into no more than two measured lines', () => {
    const headlineHeight =
      DAILY_SHARE_CARD_LAYOUT.headline.bottom - DAILY_SHARE_CARD_LAYOUT.headline.top;
    const fitted = fitTextLines(
      'Claude Code took the scenic route that day even with an unusually descriptive headline',
      {
        maxWidth: 560,
        maxLines: 2,
        maxHeight: headlineHeight,
        maxFontSize: 40,
        minFontSize: 20,
        measure: (fontSize, text) => text.length * fontSize * 0.54,
      },
    );

    expect(fitted.lines).toHaveLength(2);
    expect(fitted.fontSize).toBeGreaterThanOrEqual(20);
    expect(fitted.lines.every((line) => line.length * fitted.fontSize * 0.54 <= 560)).toBe(true);
    expect(fitted.lineHeight * fitted.lines.length).toBeLessThanOrEqual(headlineHeight);
  });

  it('truncates pathological copy instead of entering another layout band', () => {
    const fitted = fitTextLines('supercalifragilisticexpialidocious '.repeat(12), {
      maxWidth: 180,
      maxLines: 2,
      maxFontSize: 30,
      minFontSize: 18,
      measure: (fontSize, text) => text.length * fontSize * 0.6,
    });

    expect(fitted.lines).toHaveLength(2);
    expect(fitted.lines[1]).toMatch(/…$/);
    expect(fitted.lines.every((line) => line.length * fitted.fontSize * 0.6 <= 180)).toBe(true);
  });

  it('emits every card variable the preview stylesheet consumes', () => {
    const consumed = new Set([...appCss.matchAll(/--card-[a-z-]+/g)].map((match) => match[0]));
    const emitted = shareCardLayoutStyle();

    expect(consumed.size).toBeGreaterThan(0);
    for (const name of consumed) {
      expect(emitted).toContain(`${name}:`);
    }
  });

  it('simplifies tertiary copy before the protected bands shrink on narrow cards', () => {
    const narrowStyles = appCss.slice(appCss.indexOf('@media (max-width: 420px)'));

    expect(narrowStyles).toMatch(
      /\.share-brand-lockup small,\s*\.share-metric-context,\s*\.share-preview-activity\s*\{\s*display: none;\s*\}/,
    );
    expect(narrowStyles).toMatch(
      /\.share-preview-headline\s*\{[^}]*font-size:\s*10px;[^}]*line-height:\s*1\.02;[^}]*\}/,
    );
    expect(narrowStyles).not.toMatch(/\.share-preview-headline\s*\{[^}]*font-size:\s*13px;[^}]*\}/);
    expect(narrowStyles).toMatch(/\.share-metric-lockup strong\s*\{[^}]*font-size:\s*38px;[^}]*\}/);
    expect(appCss).toMatch(
      /\.share-modal\s*\{[^}]*width:\s*calc\(100% - 20px\);[^}]*max-width:\s*700px;[^}]*max-height:\s*calc\(100vh - 20px\);[^}]*\}/,
    );
    expect(appCss).toMatch(
      /\.envy-callout-actions\s*\{[^}]*width:\s*100%;[^}]*flex-direction:\s*column;[^}]*\}/,
    );
  });
});
