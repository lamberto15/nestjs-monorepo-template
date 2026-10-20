import { drawSlug } from './sign-up-tenant.js';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  });
});
