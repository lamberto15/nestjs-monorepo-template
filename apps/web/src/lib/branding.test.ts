import { describe, expect, it } from 'vitest';
import { applyBrandColor, readableOn } from './branding';

describe('readableOn', () => {
  it.each([
    ['#000000', '#ffffff'],
    ['#ffffff', '#000000'],
    ['#0a84ff', '#000000'],
    ['#1d4ed8', '#ffffff'],
    ['#facc15', '#000000'],
    ['#7f1d1d', '#ffffff'],
  ])('puts %s under %s text', (background, text) => {
    expect(readableOn(background)).toBe(text);
  });
});

describe('applyBrandColor', () => {
  const root = () => document.createElement('html');

  it('sets the theme tokens, and takes them off', () => {
    const html = root();
    applyBrandColor('#1d4ed8', html);
    expect(html.style.getPropertyValue('--primary')).toBe('#1d4ed8');
    expect(html.style.getPropertyValue('--primary-foreground')).toBe('#ffffff');
    expect(html.style.getPropertyValue('--sidebar-primary')).toBe('#1d4ed8');
    applyBrandColor(null, html);
    expect(html.style.getPropertyValue('--primary')).toBe('');
    expect(html.style.getPropertyValue('--sidebar-primary-foreground')).toBe(
      '',
    );
  });

  it.each([
    'red',
    '#fff',
    'url(https://evil.example/x)',
    '#000000;background:red',
    '#00000g',
  ])('ignores %s: only #rrggbb reaches a style', (bad) => {
    const html = root();
    applyBrandColor('#1d4ed8', html);
    applyBrandColor(bad, html);
    expect(html.style.getPropertyValue('--primary')).toBe('');
    expect(html.getAttribute('style') ?? '').not.toContain('evil');
  });
});
