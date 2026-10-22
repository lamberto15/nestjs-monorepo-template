import { slugOf } from './access.seeder.js';
import { drawSlug } from './sign-up-tenant.js';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('slugOf', () => {
  it('is the name in lowercase words joined by dashes, at most 48 characters', () => {
    expect(slugOf('Acme Corp')).toBe('acme-corp');
    expect(slugOf('  --Acme  Corp--  ')).toBe('acme-corp');
    expect(slugOf('x'.repeat(60))).toBe('x'.repeat(48));
    expect(slugOf('株式会社')).toBe('tenant');
    expect(slugOf('---')).toBe('tenant');
  });

  it('slugs a long name of separators in linear time', () => {
    const name = `${' -'.repeat(25_000)}x${'- '.repeat(25_000)}`;
    const started = performance.now();
    expect(slugOf(name)).toBe('x');
    expect(drawSlug(name)).toMatch(/^x-[a-z0-9]{6}$/);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('drawSlug', () => {
  it('is the name’s slug and a random suffix', () => {
    expect(drawSlug('Acme Corp')).toMatch(/^acme-corp-[a-z0-9]{6}$/);
    expect(drawSlug('Acme Corp')).not.toBe(drawSlug('Acme Corp'));
  });

  it('fits the slug rule and 48 characters for any name', () => {
    for (const name of [
      'x'.repeat(120),
      `${'a'.repeat(40)}-${'b'.repeat(40)}`,
      'شركة',
      '株式会社',
      '---',
    ]) {
      const slug = drawSlug(name);
      expect(slug).toMatch(SLUG);
      expect(slug.length).toBeLessThanOrEqual(48);
    }
    expect(drawSlug('株式会社')).toMatch(/^tenant-[a-z0-9]{6}$/);
    // The cut at 41 falls right after a dash: it goes too.
    expect(drawSlug(`${'a'.repeat(40)} b`)).toMatch(
      new RegExp(`^${'a'.repeat(40)}-[a-z0-9]{6}$`),
    );
  });
});
