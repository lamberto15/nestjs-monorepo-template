import { z } from 'zod';

/** At most this many actions per rule: a rule's fan-out is bounded. */
export const MAX_ACTIONS = 5;
/** At most this many people one `notify` action tells. */
export const MAX_NOTIFIED = 10;
/** A simulation looks at this many records at most. */
export const MAX_SIMULATED = 50;

/**
 * What a rule may do: a closed set the platform carries out itself, each
 * under the rule's owner's permissions. No code, no URL of its own.
 */
export const automationActionSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('setField'),
      field: z.string().min(1).max(100),
      value: z
        .union([z.string().max(10_000), z.number(), z.boolean(), z.null()])
        .describe("The field's new value, as its PATCH route takes it."),
    }),
    z.object({
      type: z.literal('addTag'),
      tagId: z.uuid().describe('A tag of the subject (GET /v1/tags).'),
    }),
    z.object({
      type: z.literal('notify'),
      userIds: z
        .array(z.uuid())
        .min(1)
        .max(MAX_NOTIFIED)
        .describe('Members told (in-app, by their preferences); only those who may read the record.'),
    }),
    z.object({
      type: z.literal('webhook'),
      clientId: z
        .uuid()
        .describe(
          "An API client of the tenant: its endpoints subscribed to `automation.matched` get the record, as that client may read it (only when it may).",
        ),
    }),
  ])
  .meta({ example: { type: 'addTag', tagId: '00000000-0000-4000-8000-000000000001' } });
export type AutomationAction = z.infer<typeof automationActionSchema>;

const actions = z.array(automationActionSchema).min(1).max(MAX_ACTIONS);

/** What a rule is: its trigger, conditions and actions (the parts a version counts). */
const definition = {
  subject: z
    .string()
    .min(1)
    .max(100)
    .describe('A subject that takes automations (GET /v1/automation-rules/subjects).')
    .meta({ example: 'Note' }),
  trigger: z
    .enum(['created', 'updated'])
    .describe('A record of the subject created, or changed.'),
  field: z
    .string()
    .min(1)
    .max(100)
    .nullable()
    .default(null)
    .describe('With `updated`: only when this field changed.'),
  filters: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      'Conditions: the subject\'s list filters, as on its list route ({ "title.contains": "urgent" }, `filter` for and/or groups).',
    ),
  actions,
};

/** Body of `POST /automation-rules`: a draft, until activated. */
export const createAutomationRuleSchema = z.object({
  name: z.string().trim().min(1).max(200).meta({ example: 'Tag urgent notes' }),
  ...definition,
});
export type CreateAutomationRuleDto = z.infer<typeof createAutomationRuleSchema>;

/** Body of `PATCH /automation-rules/{id}`: only what is sent changes. */
export const updateAutomationRuleSchema = z.object({
  name: createAutomationRuleSchema.shape.name.optional(),
  trigger: definition.trigger.optional(),
  field: z.string().min(1).max(100).nullable().optional(),
  filters: z.record(z.string(), z.string()).optional(),
  actions: actions.optional(),
});
export type UpdateAutomationRuleDto = z.infer<typeof updateAutomationRuleSchema>;

export const automationRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  subject: z.string(),
  trigger: z.enum(['created', 'updated']),
  field: z.string().nullable(),
  filters: z.record(z.string(), z.string()),
  actions: z.array(automationActionSchema),
  status: z
    .enum(['draft', 'active', 'disabled'])
    .describe('Only an active rule runs; a change of what it does makes it a draft again.'),
  version: z.number().int().describe('Counts the changes of its trigger, conditions and actions.'),
  owner: z
    .string()
    .nullable()
    .describe('`user:<id>` of who activated it: it runs with their permissions.'),
  activatedAt: z.iso.datetime().nullable(),
  disabledReason: z
    .string()
    .nullable()
    .describe('`manual`, `owner_inactive`, `run_limit`, `failing`, `subject_gone`.'),
  failures: z.number().int().describe('Failed runs in a row.'),
  lastRunAt: z.iso.datetime().nullable(),
  lastStatus: z.enum(['succeeded', 'failed']).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** One action as a run (or a simulation) found it: allowed under the rule's principal, or why not. */
export const automationRunActionSchema = z.object({
  type: z.enum(['setField', 'addTag', 'notify', 'webhook']),
  allowed: z.boolean(),
  reason: z
    .string()
    .nullable()
    .describe('Why not: `forbidden`, `field_forbidden`, `unknown_tag`, `no_recipient`, `client_cannot_read`.'),
  detail: z
    .string()
    .describe('What it does: `title = "…"`, the tag, how many are told, the client.'),
});
export type AutomationRunAction = z.infer<typeof automationRunActionSchema>;

export const automationRunSchema = z.object({
  id: z.string(),
  ruleVersion: z.number().int(),
  recordId: z.string(),
  status: z.enum(['succeeded', 'failed']),
  actions: z.array(automationRunActionSchema),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

/** Body of `POST /automation-rules/simulate`: a draft rule (or a stored one's definition). */
export const simulateAutomationRuleSchema = z.object({
  ...definition,
  recordIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_SIMULATED)
    .optional()
    .describe('These records; default: the most recently changed ones.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SIMULATED)
    .default(20)
    .describe(`Records looked at, at most (${MAX_SIMULATED}).`),
});
export type SimulateAutomationRuleDto = z.infer<typeof simulateAutomationRuleSchema>;

export const automationSimulationSchema = z.object({
  subject: z.string(),
  limit: z.number().int().describe('The sample limit this simulation used.'),
  matched: z.number().int().describe('Records that match the conditions, in the sample.'),
  truncated: z
    .boolean()
    .describe('The limit was reached: more records may match than shown.'),
  triggerSimulated: z
    .boolean()
    .describe('False with a `field` trigger: records are checked as they are now, as if that field had just changed.'),
  matches: z.array(
    z.object({
      recordId: z.string(),
      title: z
        .string()
        .nullable()
        .describe('Its title, when your permissions show it.'),
      actions: z.array(automationRunActionSchema),
    }),
  ),
});
export type AutomationSimulation = z.infer<typeof automationSimulationSchema>;

/** A subject rules may be about (`GET /automation-rules/subjects`). */
export const automationSubjectSchema = z.object({
  subject: z.string().meta({ example: 'Note' }),
  path: z.string().meta({ example: 'notes' }),
  fields: z
    .array(z.string())
    .describe('Fields an `updated` trigger may watch.'),
  settable: z
    .array(z.string())
    .describe('Fields a `setField` action may set.'),
  tags: z.boolean().describe('Whether its records take tags (`addTag`).'),
});
