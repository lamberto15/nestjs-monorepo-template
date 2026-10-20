import { suppressSmallGroups } from './suppression.js';

describe('suppressSmallGroups', () => {
  const values = (figures: Parameters<typeof suppressSmallGroups>[0], k = 10) =>
    Object.fromEntries(
      suppressSmallGroups(figures, k).map((f) => [
        `${f.metric}/${f.dimension}`,
        f.value,
      ]),
    );

  it('withholds counts from 1 to k - 1, keeps 0 and k or more', () => {
    expect(
      values([
        { metric: 'a', dimension: '', count: 0 },
        { metric: 'b', dimension: '', count: 1 },
        { metric: 'c', dimension: '', count: 9 },
        { metric: 'd', dimension: '', count: 10 },
        { metric: 'e', dimension: '', count: 1234 },
      ]),
    ).toEqual({ 'a/': 0, 'b/': null, 'c/': null, 'd/': 10, 'e/': 1234 });
  });

  it('withholds the smallest other cell when a breakdown has one withheld (no subtraction)', () => {
    expect(
      values([
        { metric: 'users.active', dimension: '', count: 62 },
        { metric: 'users.by_locale', dimension: 'en', count: 40 },
        { metric: 'users.by_locale', dimension: 'de', count: 20 },
        { metric: 'users.by_locale', dimension: 'fr', count: 2 },
      ]),
    ).toEqual({
      'users.active/': 62,
      'users.by_locale/en': 40,
      'users.by_locale/de': null,
      'users.by_locale/fr': null,
    });
  });

  it('adds nothing when two or more cells of a breakdown are withheld already', () => {
    expect(
      values([
        { metric: 'm', dimension: 'x', count: 50 },
        { metric: 'm', dimension: 'y', count: 3 },
        { metric: 'm', dimension: 'z', count: 4 },
      ]),
    ).toEqual({ 'm/x': 50, 'm/y': null, 'm/z': null });
  });

  it('withholds a lone cell, which is its own total', () => {
    expect(values([{ metric: 'm', dimension: 'x', count: 5 }])).toEqual({
      'm/x': null,
    });
  });

  it('keeps breakdowns apart', () => {
    expect(
      values(
        [
          { metric: 'p', dimension: 'x', count: 2 },
          { metric: 'p', dimension: 'y', count: 30 },
          { metric: 'q', dimension: 'x', count: 30 },
          { metric: 'q', dimension: 'y', count: 40 },
        ],
        5,
      ),
    ).toEqual({ 'p/x': null, 'p/y': null, 'q/x': 30, 'q/y': 40 });
  });
});
