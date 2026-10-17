import { z } from 'zod';
import { settingValueSchema } from './setting-value-schema.js';

describe('settingValueSchema', () => {
  it('describes a boolean (a flag)', () => {
    expect(settingValueSchema(z.boolean())).toMatchObject({
      type: 'boolean',
      schema: { type: 'boolean' },
    });
  });

  it('describes a number with its inclusive bounds, whole numbers marked', () => {
    const described = settingValueSchema(z.number().int().min(12).max(64));
    expect(described).toMatchObject({
      type: 'number',
      min: 12,
      max: 64,
      integer: true,
      schema: { type: 'integer', minimum: 12, maximum: 64 },
    });
    expect(settingValueSchema(z.number().min(0.5))).toEqual({
      type: 'number',
      min: 0.5,
      schema: expect.objectContaining({ type: 'number', minimum: 0.5 }),
    });
  });

  it('leaves out the safe-integer bounds of an unbounded int(), and exclusive bounds (in `schema` only)', () => {
    const unbounded = settingValueSchema(z.number().int());
    expect(unbounded).not.toHaveProperty('min');
    expect(unbounded).not.toHaveProperty('max');
    const exclusive = settingValueSchema(z.number().positive());
    expect(exclusive).not.toHaveProperty('min');
    expect(exclusive.schema).toMatchObject({ exclusiveMinimum: 0 });
  });

  it('describes a string with its maxLength, and its pattern in `schema`', () => {
    const described = settingValueSchema(
      z
        .string()
        .max(40)
        .regex(/^\d+(ms|s|m|h|d)$/),
    );
    expect(described).toMatchObject({
      type: 'string',
      maxLength: 40,
      schema: { type: 'string', maxLength: 40, pattern: '^\\d+(ms|s|m|h|d)$' },
    });
    expect(settingValueSchema(z.string())).not.toHaveProperty('maxLength');
  });

  it('describes an enum with its options, from z.enum or a union of literals', () => {
    expect(settingValueSchema(z.enum(['table', 'cards']))).toMatchObject({
      type: 'enum',
      options: ['table', 'cards'],
      schema: { enum: ['table', 'cards'] },
    });
    expect(
      settingValueSchema(z.union([z.literal('a'), z.literal(2)])),
    ).toMatchObject({ type: 'enum', options: ['a', 2] });
  });

  it('calls anything else json, with its JSON Schema', () => {
    const object = settingValueSchema(
      z.object({ start: z.string(), end: z.string() }),
    );
    expect(object).toMatchObject({
      type: 'json',
      schema: { type: 'object', required: ['start', 'end'] },
    });
    expect(object).not.toHaveProperty('options');
    expect(settingValueSchema(z.string().nullable()).type).toBe('json');
    expect(settingValueSchema(z.array(z.number())).type).toBe('json');
  });

  it('describes what a client sends (the input), and never throws on what JSON Schema cannot say', () => {
    // A transform: the input is a string.
    expect(settingValueSchema(z.string().transform(Number)).type).toBe(
      'string',
    );
    // A date has no JSON Schema: anything, checked on PUT.
    expect(settingValueSchema(z.date())).toMatchObject({ type: 'json' });
  });
});
