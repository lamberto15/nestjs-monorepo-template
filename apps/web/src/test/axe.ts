import axe from 'axe-core';

/**
 * The ids of the axe rules the page breaks (axe-core runs in jsdom: no
 * layout, so colour contrast and the rules that need it are left to the
 * browser scans of apps/web-e2e). `rules` limits the run to those.
 */
export async function axeViolations(
  rules: string[],
  context: axe.ElementContext = document,
) {
  const result = await axe.run(context, {
    runOnly: { type: 'rule', values: rules },
  });
  return result.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.map(
      (node) => node.html + (node.failureSummary ?? ''),
    ),
  }));
}
