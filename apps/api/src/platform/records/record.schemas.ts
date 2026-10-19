import { z } from 'zod';
import { bulkRequestSchema } from '../bulk/bulk.schemas.js';
import {
  customValuesInputSchema,
  customValuesSchema,
} from '../custom-fields/custom-field.schemas.js';
import { fieldSchemas } from '../fields/fields.js';
import { tagRefSchema } from '../tags/tag.schemas.js';
import { numberFormat, type RecordDeclaration, takes } from './record.js';
import { recordCanSchema } from './record-can.js';

/** `INV-2026-00042`: what a number looks like, for the docs. */
const numberExample = (declaration: RecordDeclaration) => {
  const { prefix, perYear, width } = numberFormat(declaration);
  return [prefix, perYear ? 'YYYY' : '', '1'.padStart(width, '0')]
    .filter(Boolean)
    .join('-');
};

/**
 * A record's API schemas, from its declaration (record.ts): `create` (POST's
 * body), `update` (PATCH's), `response` (a record as the API shows it: id,
 * owner, team, the fields, tags, dates, the recycle bin's, `can` with
 * `?include=can`; never its tenant, the request's own), `bulk` (POST
 * /<x>/bulk's body, when it takes bulk).
 */
export function recordSchemas<const D extends RecordDeclaration>(
  declaration: D,
) {
  const fields = fieldSchemas(declaration.fields);
  const custom = takes(declaration, 'custom');
  // Checked against the subject's active custom fields by the service (RecordLifecycle.values).
  const create = fields.create.extend({
    ...(custom && { custom: customValuesInputSchema.optional() }),
  });
  const update = create.partial();
  const noun = declaration.noun;
  const response = z.object({
    id: z.uuid(),
    ownerId: z
      .string()
      .describe('Who created it: `user:<id>` or `client:<id>`.'),
    ...(declaration.team && {
      teamId: z.uuid().nullable().describe("The creator's team."),
    }),
    ...(takes(declaration, 'numbered') && {
      number: z
        .string()
        .nullable()
        .describe(
          `Its human-readable number (${numberExample(declaration)}), gapless per tenant, assigned when it is created. Read-only; null for ${declaration.noun}s from before numbering.`,
        ),
    }),
    ...fields.response,
    ...(takes(declaration, 'tags') && {
      tags: z
        .array(tagRefSchema)
        .describe(
          `Its tags, by name (PUT /v1/${declaration.path}/{id}/tags sets them).`,
        ),
    }),
    ...(custom && {
      custom: customValuesSchema
        .optional()
        .describe(
          "Custom field values by key; left out when your permissions don't include them.",
        ),
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    ...(declaration.softDelete && {
      deletedAt: z.iso
        .datetime()
        .nullable()
        .describe(
          `Set while the ${noun} is in the recycle bin (\`?deleted=true\`).`,
        ),
      deletedBy: z
        .string()
        .nullable()
        .describe('Who deleted it: `user:<id>` or `client:<id>`.'),
    }),
    can: recordCanSchema(declaration.softDelete, {
      issue: takes(declaration, 'pdf'),
    }),
  });
  const actions = [
    'delete',
    'update',
    ...(declaration.softDelete ? (['restore'] as const) : []),
  ] as const;
  return {
    create,
    update,
    response,
    bulk: bulkRequestSchema([...actions] as [string, ...string[]], update),
  };
}

export type RecordSchemas = ReturnType<typeof recordSchemas>;
