import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type Page } from '@playwright/test';
import { stateFile, type Role } from './accounts';

/** The signed-in state of a role for a file or a group (test.use). */
export const asRole = (role: Role) => ({ storageState: stateFile(role) });

/**
 * An axe scan of the page as it is: serious and critical violations fail the
 * test; every violation, minor ones included, is attached to the test, which
 * the report and the job summary (scripts/axe-summary.mjs) list.
 */
export const test = base.extend<{
  expectAccessible: (page: Page, name: string) => Promise<void>;
}>({
  // Every page of the test's context runs under production's policy (`vite
  // preview` sends caddy/Caddyfile's headers, apps/web/production-headers.ts):
  // a `securitypolicyviolation` in any of them fails the test, with what was
  // refused. A document's only: a worker's own violations don't reach it.
  context: async ({ context }, use) => {
    const violations: string[] = [];
    await context.exposeBinding(
      'reportPolicyViolation',
      ({ page }, violation: string) => {
        violations.push(`${page.url()}: ${violation}`);
      },
    );
    await context.addInitScript(() => {
      document.addEventListener(
        'securitypolicyviolation',
        (event) => {
          const report = (
            window as unknown as {
              reportPolicyViolation: (violation: string) => Promise<void>;
            }
          ).reportPolicyViolation;
          void report(
            `${event.effectiveDirective} refused ${event.blockedURI || 'inline'} (${event.sourceFile}:${event.lineNumber})`,
          );
        },
        true,
      );
    });
    await use(context);
    expect(violations, 'Content-Security-Policy violations').toEqual([]);
  },
  // Playwright reads the fixtures a function uses from its first parameter's
  // destructuring: it must be a pattern, here an empty one.
  // oxlint-disable-next-line no-empty-pattern
  expectAccessible: async ({}, use, testInfo) => {
    await use(async (page, name) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
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
          violation.impact === 'serious' || violation.impact === 'critical',
      );
      expect(blocking, `serious or critical violations on ${name}`).toEqual([]);
    });
  },
});

export { expect };
