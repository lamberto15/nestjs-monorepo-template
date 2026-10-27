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

/** The contrast of `--destructive` on `--background` with `alpha` of it mixed in. */
function contrastOf(block: string, alpha: number) {
  const token = (name: string) =>
    new RegExp(`--${name}: (oklch\\([^)]*\\))`).exec(block)![1]!;
  // sRGB gamma is applied to the mixed colour, as a browser blends in sRGB.
  const encode = (c: number) =>
    c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  const decode = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const fg = linear(token('destructive'));
  const background = linear(token('background'));
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
});
