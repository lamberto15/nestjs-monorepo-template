import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The destructive button and badge are text-destructive on a 10% tint of it
// (bg-destructive/10): axe "color-contrast" wants 4.5:1 (WCAG AA), which a
// browser scan checks on the real pages; the tokens are checked here.
const css = readFileSync(
  resolve(import.meta.dirname, '../../../packages/ui/src/styles/globals.css'),
  'utf8',
);

/** An `oklch(L C H)` as linear sRGB (Ottosson), clipped to the gamut. */
function linear(value: string): number[] {
  const [l, c, h] = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/
    .exec(value)!
    .slice(1)
    .map(Number) as [number, number, number];
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const [x, y, z] = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ];
  return [
    4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z,
    -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z,
    -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z,
  ].map((channel) => Math.min(1, Math.max(0, channel)));
}

const luminance = ([r, g, b]: number[]) =>
  0.2126 * r! + 0.7152 * g! + 0.0722 * b!;

/** The contrast of `--destructive` on `--background` (or another surface token) with `alpha` of it mixed in. */
function contrastOf(block: string, alpha: number, surface = 'background') {
  const token = (name: string) =>
    new RegExp(`--${name}: (oklch\\([^)]*\\))`).exec(block)![1]!;
  // sRGB gamma is applied to the mixed colour, as a browser blends in sRGB.
  const encode = (c: number) =>
    c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  const decode = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const fg = linear(token('destructive'));
  const background = linear(token(surface));
  const tint = fg.map((c, i) =>
    decode((1 - alpha) * encode(background[i]!) + alpha * encode(c)),
  );
  const [light, dark] = [luminance(fg), luminance(tint)].toSorted(
    (a, b) => b - a,
  ) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

describe('the destructive colour', () => {
  const light = css.slice(css.indexOf(':root'), css.indexOf('\n.dark {'));
  const dark = css.slice(css.indexOf('\n.dark {'));

  it('reads at 4.5:1 on its own 10% tint in the light theme', () => {
    expect(contrastOf(light, 0.1)).toBeGreaterThanOrEqual(4.5);
  });

  it('reads at 4.5:1 on its own 20% tint in the dark theme', () => {
    expect(contrastOf(dark, 0.2)).toBeGreaterThanOrEqual(4.5);
  });

  // Cards and dialogs are lighter than the page: the dark button on them
  // (measured 4.63:1; "Sign out everywhere" on /account/security).
  it('reads at 4.5:1 on its 20% tint over a dark card', () => {
    expect(contrastOf(dark, 0.2, 'card')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the chart colour of a single series', () => {
  const light = css.slice(css.indexOf(':root'), css.indexOf('\n.dark {'));
  const dark = css.slice(css.indexOf('\n.dark {'));
  const chart2 = (block: string, surface: string) => {
    const token = (name: string) =>
      new RegExp(`--${name}: (oklch\\([^)]*\\))`).exec(block)![1]!;
    const [a, b] = [
      luminance(linear(token('chart-2'))),
      luminance(linear(token(surface))),
    ].toSorted((x, y) => y - x) as [number, number];
    return (a + 0.05) / (b + 0.05);
  };

  // The bars use --chart-2, not --primary (near-white in the dark theme): WCAG
  // 1.4.11 asks 3:1 of a graphic against what it sits on.
  it('has 3:1 against the page and a card in both themes', () => {
    expect(chart2(light, 'background')).toBeGreaterThanOrEqual(3);
    expect(chart2(dark, 'card')).toBeGreaterThanOrEqual(3);
  });
});
