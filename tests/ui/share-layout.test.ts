import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DAILY_SHARE_CARD_LAYOUT,
  fitTextLines,
  shareCardLayoutStyle
} from '../../src/lib/components/share-layout';

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
        measure: (fontSize, text) => text.length * fontSize * 0.54
      }
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
      measure: (fontSize, text) => text.length * fontSize * 0.6
    });

    expect(fitted.lines).toHaveLength(2);
    expect(fitted.lines[1]).toMatch(/…$/);
    expect(fitted.lines.every((line) => line.length * fitted.fontSize * 0.6 <= 180)).toBe(true);
  });

  it('simplifies tertiary copy before the protected bands shrink on narrow cards', () => {
    const css = readFileSync('src/app.css', 'utf8');
    const narrowStyles = css.slice(css.indexOf('@media (max-width: 420px)'));

    expect(narrowStyles).toContain('.share-brand-lockup small,');
    expect(narrowStyles).toContain('.share-metric-context,');
    expect(narrowStyles).toContain('.share-preview-activity { display: none; }');
    expect(narrowStyles).toContain('.share-preview-headline { font-size: 10px; line-height: 1.02; }');
    expect(narrowStyles).not.toContain('.share-preview-headline { font-size: 13px; }');
    expect(narrowStyles).toContain('.share-metric-lockup strong { font-size: 38px; }');
    expect(css).toContain(
      '.share-modal { width: calc(100% - 20px); max-width: 700px; max-height: calc(100vh - 20px); }'
    );
    expect(css).toContain('.envy-callout-actions { width: 100%; flex-direction: column; }');
  });
});
