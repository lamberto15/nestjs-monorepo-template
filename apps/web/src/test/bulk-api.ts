import { http, HttpResponse } from 'msw/http';
import { problem } from '@/test/server';

// The API of a list that hosts the bulk actions (features/bulk), in memory:
// the list with its recycle bin, `POST {path}/bulk` and `GET /v1/bulk/{id}`.
// The tests of the actions share it, whichever list they run on (a feature's
// or the test-only one): the list's own routes come from `records`.

export type BulkAnswer = { status?: number; body: Record<string, unknown> };

/** The bodies of the `POST …/bulk` requests the handlers saw, in order. */
export const bodiesOf = (calls: { bulk: { body: unknown }[] }) =>
  calls.bulk.map((call) => call.body);

const TITLE_FIELD = {
  name: 'title',
  type: 'string',
  operators: ['contains'],
  sortable: true,
  custom: false,
};

/** What `GET /v1/lists/{subject}` says of a list with a search and a recycle bin. */
const describeList = (subject: string) => ({
  subject,
  fields: [TITLE_FIELD],
  select: ['id', 'title', 'createdAt'],
  search: true,
  recycleBin: true,
  defaultSort: '-createdAt',
  limits: { defaultLimit: 50, maxLimit: 100 },
});

/** A run's result, as the API reports it when it ends (nothing skipped). */
export const bulkResult = (
  done: number,
  failed: number,
  results: Record<string, unknown>[] = [],
) => ({ done, failed, skipped: 0, results });

/** The API queued the run (202): `GET /v1/bulk/{id}` tells how it goes. */
export const queuedRun = (id: string): BulkAnswer => ({
  status: 202,
  body: { id, status: 'queued' },
});

/** One poll's answer for a queued delete run: running, or completed with its result. */
export const deleteJob = (
  id: string,
  name: string,
  status: 'running' | 'completed',
  done: number,
  failed: number,
) => ({
  id,
  name,
  action: 'delete',
  status,
  progress: { processed: done + failed, done, failed },
  ...(status === 'completed' && { result: bulkResult(done, failed) }),
});

/**
 * The handlers of a list at `path` for `subject`, and the calls they saw.
 * `POST {path}/bulk` answers `answer`; `GET /v1/bulk/{id}` walks through
 * `job` (one entry per poll, the last repeated). The list says how many
 * records match (`total`) and searches, so "all matching" has a filter.
 */
export function bulkHandlers(options: {
  path: string;
  subject: string;
  /** Every record, deleted or not: the list shows the live ones, or the bin. */
  records: () => { deletedAt: string | null }[];
  answer?: BulkAnswer;
  job?: unknown[];
  total?: number;
  /** The API refuses to start the run (503). */
  refuse?: boolean;
}) {
  const calls = {
    bulk: [] as { body: unknown; key: string | null }[],
    lists: [] as string[],
    polls: 0,
  };
  const handlers = [
    http.get('/v1/lists/:subject', () =>
      HttpResponse.json(describeList(options.subject)),
    ),
    http.get(options.path, ({ request }) => {
      const url = new URL(request.url);
      calls.lists.push(url.search);
      const bin = url.searchParams.get('deleted') === 'true';
      const items = options
        .records()
        .filter((record) => !!record.deletedAt === bin);
      return HttpResponse.json({
        items,
        page: 1,
        pageCount: 1,
        total: options.total ?? items.length,
      });
    }),
    http.post(`${options.path}/bulk`, async ({ request }) => {
      calls.bulk.push({
        body: await request.json(),
        key: request.headers.get('idempotency-key'),
      });
      if (options.refuse) {
        return problem(503, 'service_unavailable');
      }
      const answer: BulkAnswer = options.answer ?? { body: bulkResult(2, 0) };
      return HttpResponse.json(answer.body, { status: answer.status ?? 200 });
    }),
    http.get('/v1/bulk/:id', () => {
      const poll = calls.polls++;
      const step = options.job?.[Math.min(poll, options.job.length - 1)];
      return step ? HttpResponse.json(step) : problem(404, 'not_found');
    }),
  ];
  return { calls, handlers };
}
