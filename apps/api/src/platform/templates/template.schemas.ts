import { z } from 'zod';
import { pageSchema } from '../../core/http/pagination.js';
import { TEMPLATE_VISIBILITIES } from './templates.tables.js';

/** At most this many values in one template (a create body has far fewer fields). */
export const MAX_TEMPLATE_VALUES = 100;

const values = z
  .record(z.string().min(1).max(100), z.unknown())
  .refine((value) => Object.keys(value).length <= MAX_TEMPLATE_VALUES, {
    message: `At most ${MAX_TEMPLATE_VALUES} values.`,
  })
  .describe(
    "Values of the subject's create body (`POST /v1/<path>`), as that route takes them. Only fields it declares and you may set: no ids, numbers, owners or dates the system sets. Required fields may be left out.",
  )
  .meta({ example: { title: 'Weekly status', body: 'Done:\nNext:' } });

const name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .meta({ example: 'Weekly status' });

const unitId = z
  .uuid()
  .describe('For `visibility: "unit"`: an organizational unit you belong to.');

/** A record template. */
export const templateSchema = z
  .object({
    id: z.string(),
    subject: z.string().meta({ example: 'Note' }),
    name,
    visibility: z.enum(TEMPLATE_VISIBILITIES),
    unitId: z.string().nullable().describe('Set for a `unit` template.'),
    owner: z
      .string()
      .describe(
        '`user:<id>` or `client:<id>`; `anonymous` once its owner’s account is gone.',
      ),
    mine: z.boolean().describe('You own it.'),
    editable: z
      .boolean()
      .describe(
        'You may change and delete it (its owner, or a template manager).',
      ),
    values,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'RecordTemplate' });

/** A page of record templates (`GET /v1/templates`). */
export const templatePageSchema = pageSchema(templateSchema).meta({
  id: 'RecordTemplatePage',
});

/** A subject that takes templates (`GET /v1/templates/subjects`). */
export const templateSubjectsSchema = z
  .object({
    items: z.array(
      z.object({
        subject: z.string().meta({ example: 'Note' }),
        fields: z
          .array(z.string())
          .describe('The create fields a template may hold and you may set.'),
      }),
    ),
  })
  .meta({ id: 'RecordTemplateSubjects' });

/** `GET /templates/{id}/preview`: the template checked again, ready to use as a create body. */
export const templatePreviewSchema = z
  .object({
    template: templateSchema,
    values: z
      .record(z.string(), z.unknown())
      .describe(
        "The values that still hold: send them (with what the user adds) as the body of the subject's create route, which validates and authorizes them as any create.",
      ),
    dropped: z
      .array(
        z.object({
          field: z.string(),
          reason: z.enum(['unknown', 'invalid', 'forbidden']),
          message: z.string(),
        }),
      )
      .describe(
        'Values left out because the schema or your permissions changed since: `unknown` (no longer a create field), `invalid` (the schema refuses it now), `forbidden` (you may not set that field).',
      ),
  })
  .meta({ id: 'RecordTemplatePreview' });

/** Body of `POST /templates`. */
export const createTemplateSchema = z
  .object({
    subject: z
      .string()
      .min(1)
      .max(80)
      .describe('The records: a subject `GET /v1/templates/subjects` names.')
      .meta({ example: 'Note' }),
    name,
    visibility: z.enum(TEMPLATE_VISIBILITIES).default('private'),
    unitId: unitId.optional(),
    values: values.default({}),
  })
  .refine((dto) => (dto.visibility === 'unit') === (dto.unitId !== undefined), {
    path: ['unitId'],
    message: 'unitId goes with visibility "unit", and only with it.',
  });
export type CreateTemplateDto = z.infer<typeof createTemplateSchema>;

/** Body of `PATCH /templates/{id}`: only what is sent changes (the subject never does). */
export const updateTemplateSchema = z.object({
  name: name.optional(),
  visibility: z.enum(TEMPLATE_VISIBILITIES).optional(),
  unitId: unitId.nullable().optional(),
  values: values.optional(),
});
export type UpdateTemplateDto = z.infer<typeof updateTemplateSchema>;
