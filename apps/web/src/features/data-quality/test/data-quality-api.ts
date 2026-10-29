import { http, HttpResponse } from 'msw/http';
import { problem, server } from '@/test/server';
import { useSignedIn } from '@/test/signed-in';
import type {
  DataQualityFinding,
  DataQualityScan,
  DataQualitySummary,
} from '../api';

// The data-quality API in memory (msw): the summary, one subject's
// findings, a scan, dismissal and recheck, recording what the page sent.

export const finding = (
  over: Partial<DataQualityFinding> = {},
): DataQualityFinding => ({
  id: '0198a000-0000-7000-8000-000000000001',
  subject: 'TestItem',
  recordId: '0198a000-0000-7000-8000-0000000000aa',
  check: 'missing',
  field: 'body',
  severity: 'suggestion',
  detail: null,
  checkedAt: '2026-10-28T10:00:00.000Z',
  dismissedAt: null,
  dismissedBy: null,
  ...over,
});

const completed: DataQualityScan = {
  id: '0198a000-0000-7000-8000-0000000000ff',
  status: 'completed',
  total: 12,
  scanned: 12,
  findings: 2,
  startedBy: 'user:1',
  createdAt: '2026-10-28T09:59:00.000Z',
  finishedAt: '2026-10-28T10:00:00.000Z',
};

export function useDataQualityApi(options: {
  can: string[];
  lastScan?: DataQualityScan | null;
  findings?: DataQualityFinding[];
}) {
  let lastScan = options.lastScan === undefined ? completed : options.lastScan;
  let findings = options.findings ?? [
    finding(),
    finding({
      id: '0198a000-0000-7000-8000-000000000002',
      check: 'reference',
      field: 'parentId',
      severity: 'error',
      detail: { referencedId: 'abc' },
    }),
  ];
  const calls = {
    reads: 0,
    scans: 0,
    dismissed: [] as string[],
    rechecked: [] as string[],
  };
  useSignedIn(options.can);
  const summary = (): DataQualitySummary => {
    const open = findings.filter((f) => !f.dismissedAt);
    return {
      lastScan,
      subjects: [
        {
          subject: 'TestItem',
          errors: open.filter((f) => f.severity === 'error').length,
          suggestions: open.filter((f) => f.severity === 'suggestion').length,
          dismissed: findings.length - open.length,
        },
      ],
    };
  };
  server.use(
    http.get('/v1/data-quality', () => {
      calls.reads += 1;
      return HttpResponse.json(summary());
    }),
    http.post('/v1/data-quality/scans', () => {
      calls.scans += 1;
      if (lastScan?.status === 'running') return problem(409, 'scan_running');
      lastScan = {
        ...completed,
        status: 'running',
        scanned: 3,
        finishedAt: null,
        findings: null,
      };
      return HttpResponse.json(lastScan, { status: 202 });
    }),
    http.get('/v1/data-quality/subjects/:subject/findings', ({ request }) => {
      const dismissed =
        new URL(request.url).searchParams.get('dismissed') === 'true';
      return HttpResponse.json({
        items: findings.filter((f) => !!f.dismissedAt === dismissed),
        nextCursor: null,
      });
    }),
    http.post('/v1/data-quality/findings/:id/dismiss', ({ params }) => {
      calls.dismissed.push(params.id as string);
      findings = findings.map((f) =>
        f.id === params.id
          ? { ...f, dismissedAt: '2026-10-28T11:00:00.000Z' }
          : f,
      );
      return HttpResponse.json(findings.find((f) => f.id === params.id));
    }),
    http.post('/v1/data-quality/findings/:id/recheck', ({ params }) => {
      calls.rechecked.push(params.id as string);
      findings = findings.filter((f) => f.id !== params.id);
      return HttpResponse.json({ resolved: true, finding: null });
    }),
  );
  return { calls };
}
