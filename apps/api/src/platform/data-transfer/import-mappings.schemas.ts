import { z } from 'zod';

/** At most this many saved mappings per import, and columns in one. */
export const MAX_MAPPINGS_PER_IMPORT = 50;
export const MAX_MAPPED_COLUMNS = 200;

/** A mapping as the import route's `mapping` field takes it (a JSON object). */
export const importMappingSchema = z
  .record(z.string().min(1).max(200), z.string().min(1).max(200).nullable())
  .refine((value) => Object.keys(value).length <= MAX_MAPPED_COLUMNS, {
    message: `At most ${MAX_MAPPED_COLUMNS} columns.`,
  })
  .describe(
    'The file\'s headers to the template\'s columns: `{ "Surname": "lastName", "Notes": null }` (null: ignore the column). A header not named keeps its own name. A date-time column takes the zone of the file\'s times as the template\'s header does: `{ "When": "dueAt (Asia/Dubai)" }`.',
  )
  .meta({ example: { Title: 'title', Internal: null } });

export const createImportMappingSchema = z.object({
  name: z.string().trim().min(1).max(200).meta({ example: 'CRM export' }),
  mapping: importMappingSchema,
});
export type CreateImportMappingDto = z.infer<typeof createImportMappingSchema>;

export const savedImportMappingSchema = z
  .object({
    id: z.string(),
    importer: z.string().meta({ example: 'notes' }),
    name: z.string(),
    mapping: importMappingSchema,
    stale: z
      .array(z.string())
      .describe(
        'Targets that are no longer columns you may import (the schema changed, or your permissions did): saving or using the mapping as it is would be refused; change them first.',
      ),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ImportMapping' });

export const importMappingListSchema = z.object({
  items: z.array(savedImportMappingSchema),
});
