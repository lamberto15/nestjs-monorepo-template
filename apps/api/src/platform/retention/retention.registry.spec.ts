import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { RetentionRegistry, type RetentionRule } from './retention.registry.js';
import { setRetentionSchema } from './retention.schemas.js';

const things = pgTable('things', {
  id: uuid('id').primaryKey(),
  email: text('email'),
  createdAt: timestamp('created_at'),
});

const rule = (over: Partial<RetentionRule> = {}): RetentionRule => ({
  name: 'thing',
  label: 'Things',
  subject: 'Thing',
  table: things,
  ageColumn: things.createdAt,
  action: 'purge',
  defaultDays: 90,
  ...over,
});

describe('RetentionRegistry', () => {
  it('keeps the declared rules by name', () => {
    const registry = new RetentionRegistry();
    registry.register(rule());
    registry.register(rule({ name: 'other' }));
    expect(registry.all().map((r) => r.name)).toEqual(['thing', 'other']);
    expect(registry.find('thing')?.subject).toBe('Thing');
    expect(registry.find('missing')).toBeUndefined();
  });

  it('refuses two rules of one name', () => {
    const registry = new RetentionRegistry();
    registry.register(rule());
    expect(() => registry.register(rule())).toThrow(/named "thing"/);
  });

  it('refuses an anonymising rule that says nothing about what it writes', () => {
    const registry = new RetentionRegistry();
    expect(() => registry.register(rule({ action: 'anonymise' }))).toThrow(
      /anonymise: \{ set, pending \}/,
    );
    registry.register(
      rule({
        action: 'anonymise',
        anonymise: { set: { email: null }, pending: sql`email is not null` },
      }),
    );
  });

  it('refuses a default below the rule’s own minimum', () => {
    const registry = new RetentionRegistry();
    expect(() =>
      registry.register(rule({ defaultDays: 10, minDays: 30 })),
    ).toThrow(/below its minimum/);
  });
});

describe('setRetentionSchema', () => {
  it('takes the switch, and days when sent', () => {
    expect(setRetentionSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
    expect(setRetentionSchema.parse({ enabled: false, days: 30 })).toEqual({
      enabled: false,
      days: 30,
    });
  });

  it('refuses no switch, zero days and fractions', () => {
    expect(setRetentionSchema.safeParse({}).success).toBe(false);
    expect(
      setRetentionSchema.safeParse({ enabled: true, days: 0 }).success,
    ).toBe(false);
    expect(
      setRetentionSchema.safeParse({ enabled: true, days: 1.5 }).success,
    ).toBe(false);
  });
});
