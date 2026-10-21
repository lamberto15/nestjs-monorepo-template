import { unwrap, type GetResponse } from '@nestjs-monorepo-template/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { settingsQuery } from '@/features/settings/settings';

/** The tasks the AI helper offers (`task` of `POST /v1/ai/runs`, docs/ai.md). */
export const AI_TASKS = ['summarize', 'classify'] as const;
export type AiTask = (typeof AI_TASKS)[number];

export type AiRun = GetResponse<'/v1/ai/runs/{id}'>;

/** The setting that opts a tenant in; public, so every signed-in user reads it. */
export const AI_ENABLED_KEY = 'ai.enabled';

export const aiKeys = {
  run: (id: string) => ['ai', 'run', id] as const,
};

/**
 * `POST /v1/ai/runs`: 202 with the run's id, a queue worker does the rest.
 * 403 `ai_disabled`, 409 `ai_pending`, 429 `ai_quota_exceeded` and 503
 * `ai_unavailable` are the callers' to handle.
 */
export const requestAiRun = (body: {
  source: string;
  recordId: string;
  task: AiTask;
}) => unwrap(api.POST('/v1/ai/runs', { body }));

/** `GET /v1/ai/runs/{id}`: the run's state, then its answer (kept an hour). */
export const aiRunQuery = (id: string) =>
  queryOptions({
    queryKey: aiKeys.run(id),
    queryFn: () =>
      unwrap(api.GET('/v1/ai/runs/{id}', { params: { path: { id } } })),
  });

/** Whether a run is over: nothing more will change. */
export const isOver = (run: Pick<AiRun, 'status'> | undefined) =>
  run?.status === 'completed' || run?.status === 'failed';

export interface SummarizeOutput {
  summary: string;
  keyPoints: string[];
}
export interface ClassifyOutput {
  sentiment: 'positive' | 'neutral' | 'negative';
  topic: string;
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** The answer of a summarize run, or undefined when it is not that shape. */
export function asSummary(
  output: AiRun['output'],
): SummarizeOutput | undefined {
  return output &&
    typeof output.summary === 'string' &&
    isStrings(output.keyPoints)
    ? { summary: output.summary, keyPoints: output.keyPoints }
    : undefined;
}

/** The answer of a classify run, or undefined when it is not that shape. */
export function asClassification(
  output: AiRun['output'],
): ClassifyOutput | undefined {
  return output &&
    (output.sentiment === 'positive' ||
      output.sentiment === 'neutral' ||
      output.sentiment === 'negative') &&
    typeof output.topic === 'string'
    ? { sentiment: output.sentiment, topic: output.topic }
    : undefined;
}

/**
 * Whether the tenant has turned the helper off: `ai.enabled` is a public
 * setting, so `GET /v1/settings` lists it to every signed-in user. (Whether
 * the server has a provider at all is `GET /v1/features`' `ai`.) A 403
 * `ai_disabled` on a click is still handled, for a change since this was read.
 */
export const aiOffQuery = queryOptions({
  ...settingsQuery,
  staleTime: 5 * 60_000,
  retry: false,
  meta: { errorToast: false },
  select: (items) =>
    items.find((s) => s.key === AI_ENABLED_KEY)?.value === false,
});
