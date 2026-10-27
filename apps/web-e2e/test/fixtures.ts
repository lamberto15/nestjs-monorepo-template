import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type Page } from '@playwright/test';
import { stateFile, type Role } from './accounts';

/** The signed-in state of a role for a file or a group (test.use). */
export const asRole = (role: Role) => ({ storageState: stateFile(role) });

/**
 * The best-practice rules that fail a scan whatever their impact: landmarks,
 * the page heading and the way past the navigation (docs/development.md,
 * "Browser accessibility tests"). Each passes on every page the suite scans;
 * the other best-practice rules are only listed in the report. A scan limited
 * to an open overlay (`scope`) leaves them out: they judge a whole page.
 */
export const LANDMARK_RULES = [
  'landmark-one-main',
  'landmark-no-duplicate-main',
  'page-has-heading-one',
  'region',
  'skip-link',
  'bypass',
];

export interface ScanOptions {
  /** A CSS selector: scan only what is inside it (an open dialog or menu). */
  scope?: string;
}

/**
 * Waits until the finite animations (an opening dialog, a fading menu) have
 * ended, so axe never measures a colour halfway through a transition. The
 * endless ones (a spinner) are not waited for.
 */
async function settle(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.effect?.getComputedTiming().iterations === Infinity ||
          animation.playState !== 'running',
      ),
  );
}

/**
 * An axe scan of the page as it is (WCAG 2.0 to 2.1 A and AA, and the
 * best-practice rules): serious and critical violations fail the test, and so
 * do the LANDMARK_RULES; every violation, minor ones included, is attached to
 * the test, which the report and the job summary (scripts/axe-summary.mjs)
 * list.
 */
export const test = base.extend<{
  expectAccessible: (
    page: Page,
    name: string,
    options?: ScanOptions,
  ) => Promise<void>;
}>({
  // Playwright reads the fixtures a function uses from its first parameter's
  // destructuring: it must be a pattern, here an empty one.
  // oxlint-disable-next-line no-empty-pattern
  expectAccessible: async ({}, use, testInfo) => {
    await use(async (page, name, options = {}) => {
      await settle(page);
      const builder = new AxeBuilder({ page }).withTags([
        'wcag2a',
        'wcag2aa',
        'wcag21a',
        'wcag21aa',
        'best-practice',
      ]);
      const results = await (
        options.scope ? builder.include(options.scope) : builder
      ).analyze();
      const violations = results.violations.map((violation) => ({
        page: name,
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        helpUrl: violation.helpUrl,
        nodes: violation.nodes.map((node) => node.target.join(' ')),
        detail: violation.nodes[0]?.any[0]?.message ?? '',
        html: violation.nodes[0]?.html.slice(0, 160) ?? '',
      }));
      await testInfo.attach(`axe-${name}`, {
        body: JSON.stringify(violations, null, 2),
        contentType: 'application/json',
      });
      const blocking = violations.filter(
        (violation) =>
          violation.impact === 'serious' ||
          violation.impact === 'critical' ||
          (!options.scope && LANDMARK_RULES.includes(violation.id)),
      );
      expect(blocking, `blocking violations on ${name}`).toEqual([]);
    });
  },
});

export { expect };
