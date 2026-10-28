import { z } from 'zod';

/** At most this many choices in one answer, and the default. */
export const MAX_CHOICES = 50;
export const DEFAULT_CHOICES = 20;

const field = z.object({
  name: z.string().meta({ example: 'member' }),
  provider: z.string().meta({ example: 'unit-members' }),
  label: z.string(),
  dependsOn: z
    .array(z.string())
    .describe(
      'The fields whose values this one’s choices depend on: ask for its options with `parent.<field>=<value>` for each. When one changes, drop this field’s value and ignore answers still in flight.',
    ),
});

/** `GET /choices/{set}`: the set's fields and what they depend on. */
export const choiceSetSchema = z
  .object({
    key: z.string().meta({ example: 'unit-member' }),
    label: z.string(),
    fields: z
      .array(field)
      .describe(
        'Parents before the fields that depend on them. Only the fields whose provider you may use.',
      ),
  })
  .meta({ id: 'ChoiceSet' });

/** `GET /choices`: the sets you may use. */
export const choiceSetsSchema = z
  .object({ items: z.array(choiceSetSchema) })
  .meta({ id: 'ChoiceSets' });

/** Query of `GET /choices/{set}/{field}/options`: `parent.<field>` values are read from the raw query. */
export const choiceOptionsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_CHOICES).optional(),
  })
  .catchall(z.string().max(200));
export type ChoiceOptionsQuery = z.infer<typeof choiceOptionsQuerySchema>;

/** The choices of a field, for the parent values asked about. */
export const choiceOptionsSchema = z
  .object({
    set: z.string(),
    field: z.string(),
    parents: z
      .record(z.string(), z.string())
      .describe(
        'The parent values this answer is for, echoed: show it only while they are still the form’s (an answer for an earlier parent is stale).',
      ),
    items: z.array(
      z.object({
        value: z
          .string()
          .describe('What the form stores and the server checks.'),
        label: z
          .string()
          .describe('For display only: never sent back or trusted.'),
      }),
    ),
    hasMore: z
      .boolean()
      .describe('More match: narrow with `q` (answers hold at most `limit`).'),
  })
  .meta({ id: 'ChoiceOptions' });

/** Body of `POST /choices/{set}/validate`. */
export const validateChoicesSchema = z.object({
  values: z
    .record(z.string().min(1).max(100), z.string().max(200).nullable())
    .describe(
      'The set’s fields as the form holds them, `null` or absent for none. A field’s value is checked among its choices for its parents’ values here.',
    )
    .meta({ example: { unit: '…', member: '…' } }),
});
export type ValidateChoicesDto = z.infer<typeof validateChoicesSchema>;
