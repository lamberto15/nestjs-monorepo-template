import { z } from 'zod';
import { bulkRequestSchema } from '../bulk/bulk.schemas.js';
import { fieldSchemas } from '../fields/fields.js';
import { tagRefSchema } from '../tags/tag.schemas.js';
import { type RecordDeclaration, takes } from './record.js';

/**
 * A record's API schemas, from its declaration (record.ts): `create` (POST's
 * body), `update` (PATCH's), `response` (a record as the API shows it: id,
 * owner, team, the fields, tags, dates, the recycle bin's), `bulk` (POST
 * /<x>/bulk's body, when it takes bulk).
 */
export function recordSchemas<const D extends RecordDeclaration>(
  declaration: D,
) {
  const fields = fieldSchemas(declaration.fields);
  const noun = declaration.noun;
  const response = z.object({
    id: z.uuid(),
    ownerId: z
      .string()
      .describe('Who created it: `user:<id>` or `client:<id>`.'),
    ...(declaration.team && {
      teamId: z.uuid().nullable().describe("The creator's team."),
    }),
    ...fields.response,
    ...(takes(declaration, 'tags') && {
      tags: z
        .array(tagRefSchema)
        .describe(
          `Its tags, by name (PUT /v1/${declaration.path}/{id}/tags sets them).`,
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
  });
  const actions = [
    'delete',
    'update',
    ...(declaration.softDelete ? (['restore'] as const) : []),
  ] as const;
  return {
    create: fields.create,
    update: fields.update,
    response,
    bulk: bulkRequestSchema(
      [...actions] as [string, ...string[]],
      fields.update,
    ),
  };
}

export type RecordSchemas = ReturnType<typeof recordSchemas>;
