/**
 * A seeded pseudo-random source for the money module's property tests
 * (mulberry32): every run checks the same thousands of cases, and a
 * failure reproduces. Test-only (`*.testing.ts` is no spec and no
 * runtime code).
 */
export function random(seed: number) {
  let state = seed >>> 0;
  const float = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** An integer in [0, max). */
  const int = (max: number) => Math.floor(float() * max);
  /** A bigint in [0, max): random digits, so every size shows up. */
  const bigint = (max: bigint) => {
    const digits = max.toString().length;
    const length = 1 + int(digits);
    let value = 0n;
    for (let i = 0; i < length; i++) {
      value = value * 10n + BigInt(int(10));
    }
    return value % max;
  };
  return {
    int,
    bigint,
    pick: <T>(items: readonly T[]) => items[int(items.length)],
  };
}
