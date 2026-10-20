import { z } from 'zod';
import { AI_RUN_STATUSES } from './ai.tables.js';
import { AI_TASK_NAMES } from './ai-tasks.js';

export const aiRequestSchema = z.object({
  source: z
    .string()
    .min(1)
    .max(100)
    .meta({ example: 'note' })
    .describe('The kind of record: a name the features register (`note`).'),
  recordId: z.uuid(),
  task: z
    .enum(AI_TASK_NAMES)
    .describe('`summarize` or `classify`; each has its own answer shape.'),
});
export type AiRequest = z.infer<typeof aiRequestSchema>;

/** A run handed to the workers: follow it at GET /v1/ai/runs/{id}. */
export const aiQueuedSchema = z.object({
  id: z.uuid(),
  status: z.literal('queued'),
});

export const aiRunSchema = z.object({
  id: z.uuid(),
  source: z.string(),
  subject: z.string(),
  recordId: z.uuid(),
  task: z.string(),
  promptVersion: z.string().meta({ example: 'v1' }),
  model: z
    .string()
    .nullable()
    .describe('The model id that answered (null until it did).'),
  status: z
    .enum(AI_RUN_STATUSES)
    .describe('queued → running → completed, or failed (then `error`).'),
  output: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe(
      "Once completed: the task's answer, validated against its schema. Kept for an hour; null after that (ask again).",
    ),
  inputTokens: z.int(),
  outputTokens: z.int(),
  cached: z.boolean(),
  error: z.string().nullable().describe('Why it failed, written for people.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AiRunView = z.infer<typeof aiRunSchema>;
