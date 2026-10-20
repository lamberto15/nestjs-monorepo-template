/** One figure before it is stored: a total (`dimension` '') or a breakdown's cell. */
export type Figure = { metric: string; dimension: string; count: number };

/** A figure as stored: `value` null when suppressed. */
export type PublishedFigure = {
  metric: string;
  dimension: string;
  value: number | null;
};

/**
 * Small-group suppression (statistical disclosure control) of a snapshot's
 * figures, before any of them is stored:
 *
 * - **Primary:** a count from 1 to `minGroupSize - 1` is withheld (null): a
 *   group that small could single people out (the two users of a locale).
 *   A count of 0 names nobody and is kept, as is anything of `minGroupSize`
 *   or more.
 * - **Secondary:** the cells of one breakdown (one `metric`, several
 *   dimensions) add up to a total that may be published; when exactly one
 *   cell of a breakdown is withheld, it could be worked out by subtraction,
 *   so the smallest other non-zero cell is withheld too.
 *
 * Pure: the job (PlatformAnalyticsJob) computes the counts, this decides
 * what may leave the bypass. Not protected against: differencing two days'
 * snapshots (a total that grew by one); the minimum group size and a daily
 * grain keep that coarse (docs/tenancy.md, "Platform analytics").
 */
export function suppressSmallGroups(
  figures: Figure[],
  minGroupSize: number,
): PublishedFigure[] {
  const small = (count: number) => count > 0 && count < minGroupSize;
  const withheld = new Set(figures.filter((figure) => small(figure.count)));
  const breakdowns = new Map<string, Figure[]>();
  for (const figure of figures) {
    if (figure.dimension !== '') {
      const cells = breakdowns.get(figure.metric) ?? [];
      cells.push(figure);
      breakdowns.set(figure.metric, cells);
    }
  }
  for (const cells of breakdowns.values()) {
    const hidden = cells.filter((cell) => withheld.has(cell));
    if (hidden.length !== 1) {
      continue;
    }
    const [next] = cells
      .filter((cell) => !withheld.has(cell) && cell.count > 0)
      .sort((a, b) => a.count - b.count);
    if (next) {
      withheld.add(next);
    }
  }
  return figures.map((figure) => ({
    metric: figure.metric,
    dimension: figure.dimension,
    value: withheld.has(figure) ? null : figure.count,
  }));
}
