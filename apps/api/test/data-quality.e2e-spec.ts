import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { bootApp, type TestApp } from './support.js';

interface Finding {
  id: string;
  subject: string;
  recordId: string;
  check: string;
  field: string;
  severity: string;
  detail: Record<string, string> | null;
  dismissedAt: string | null;
}

describe('data quality: checks, scans, dismissal and recheck (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const item = async (body: Record<string, unknown>) =>
    (await node.writeItem(node.admin(), body).expect(201)).body.id as string;

  /** Starts a scan and waits for it to complete. */
  const scan = async () => {
    const started = await node
      .admin()
      .post('/v1/data-quality/scans')
      .expect(202);
    expect(started.body).toMatchObject({ status: expect.any(String) });
    for (let i = 0; i < 100; i++) {
      const summary = await node.admin().get('/v1/data-quality').expect(200);
      if (summary.body.lastScan.status === 'completed') return summary.body;
      expect(summary.body.lastScan.status).not.toBe('failed');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The scan did not complete.');
  };

  const findings = async (agent: request.Agent, query = '') =>
    (
      await agent
        .get(`/v1/data-quality/subjects/TestItem/findings${query}`)
        .expect(200)
    ).body.items as Finding[];

  const key = (f: Finding) => `${f.recordId}:${f.check}:${f.field}`;

  it('finds empty recommended fields, duplicate titles and references to the recycle bin, changing no record', async () => {
    const complete = await item({ title: 'Plan', body: 'Text', code: 'A1' });
    const sparse = await item({ title: ' plan' });
    const parent = await item({ title: 'Parent', body: 'P', code: 'P1' });
    const child = await item({
      title: 'Child',
      body: 'C',
      code: 'C1',
      linkedId: parent,
    });
    await node.admin().delete(`/v1/test-items/${parent}`).expect(204);

    const done = await scan();
    expect(done.lastScan).toMatchObject({
      status: 'completed',
      total: 3,
      scanned: 3,
      findings: 5,
    });
    expect(done.subjects).toEqual(
      expect.arrayContaining([
        { subject: 'TestItem', errors: 1, suggestions: 4, dismissed: 0 },
      ]),
    );
    const found = await findings(node.admin());
    expect(found.map(key).sort((a, b) => a.localeCompare(b))).toEqual(
      [
        `${child}:reference:linkedId`,
        `${complete}:duplicate:title`,
        `${sparse}:duplicate:title`,
        `${sparse}:missing:body`,
        `${sparse}:missing:code`,
      ].sort((a, b) => a.localeCompare(b)),
    );
    expect(found.find((f) => f.check === 'reference')).toMatchObject({
      severity: 'error',
      detail: { referencedId: parent },
    });
    expect(
      found.find((f) => f.recordId === complete && f.check === 'duplicate'),
    ).toMatchObject({
      severity: 'suggestion',
      detail: { duplicateOf: sparse },
    });
    // No repair: the reference (a `keep` one, which outlives the delete) is still there.
    const read = await node.admin().get(`/v1/test-items/${child}`).expect(200);
    expect(read.body.linkedId).toBe(parent);

    // Another tenant sees none of it.
    const tenant = await node.otherTenant();
    const theirs = await tenant.admin.get('/v1/data-quality').expect(200);
    expect(theirs.body.lastScan).toBeNull();
    expect(
      theirs.body.subjects.every(
        (s: { errors: number; suggestions: number }) =>
          s.errors === 0 && s.suggestions === 0,
      ),
    ).toBe(true);
    await tenant.admin
      .post(`/v1/data-quality/findings/${found[0]!.id}/dismiss`)
      .expect(404);
  });

  it('shows no finding on a field the caller may not read, nor to someone without the permission', async () => {
    const sparse = await item({ title: 'Lonely' });
    await scan();
    const role = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `quality-${randomUUID().slice(0, 8)}`,
        permissions: [
          // Every test item, but not its text (the field-level permission).
          { subject: 'TestItem', action: 'read', conditions: [], fields: [] },
          { subject: 'DataQuality', action: 'read', conditions: [] },
        ],
      })
      .expect(201);
    const limited = await node.user([role.body.id]);
    expect((await findings(limited.agent)).map(key)).toEqual([
      `${sparse}:missing:code`,
    ]);
    const summary = await limited.agent.get('/v1/data-quality').expect(200);
    expect(summary.body.subjects).toEqual([
      { subject: 'TestItem', errors: 0, suggestions: 1, dismissed: 0 },
    ]);
    const hidden = (await findings(node.admin())).find(
      (f) => f.field === 'body',
    )!;
    // Reading is not acting, and a hidden finding is no finding.
    await limited.agent
      .post(`/v1/data-quality/findings/${hidden.id}/recheck`)
      .expect(403);
    await limited.agent.post('/v1/data-quality/scans').expect(403);

    const editor = await node.user(['editor']);
    await editor.agent.get('/v1/data-quality').expect(403);
  });

  it('keeps a dismissed finding dismissed across scans, and a recheck resolves a fixed one', async () => {
    const sparse = await item({ title: 'Sparse' });
    await scan();
    const open = await findings(node.admin());
    const code = open.find((f) => f.field === 'code')!;
    const body = open.find((f) => f.field === 'body')!;

    const dismissed = await node
      .admin()
      .post(`/v1/data-quality/findings/${code.id}/dismiss`)
      .expect(200);
    expect(dismissed.body.dismissedAt).toEqual(expect.any(String));
    expect((await findings(node.admin())).map((f) => f.id)).toEqual([body.id]);
    expect(
      (await findings(node.admin(), '?dismissed=true')).map((f) => f.id),
    ).toEqual([code.id]);
    expect(
      await node.auditEntries({ action: 'data-quality.finding-dismissed' }),
    ).toHaveLength(1);

    // A rescan finds it again: still dismissed.
    const again = await scan();
    expect(again.subjects).toEqual(
      expect.arrayContaining([
        { subject: 'TestItem', errors: 0, suggestions: 1, dismissed: 1 },
      ]),
    );

    // Still empty: the recheck says so.
    const unchanged = await node
      .admin()
      .post(`/v1/data-quality/findings/${body.id}/recheck`)
      .expect(200);
    expect(unchanged.body).toMatchObject({
      resolved: false,
      finding: { id: body.id },
    });

    const etag = (await node.admin().get(`/v1/test-items/${sparse}`)).headers
      .etag as string;
    await node
      .admin()
      .patch(`/v1/test-items/${sparse}`)
      .set('If-Match', etag)
      .send({ body: 'Now it says something' })
      .expect(200);
    const fixed = await node
      .admin()
      .post(`/v1/data-quality/findings/${body.id}/recheck`)
      .expect(200);
    expect(fixed.body).toEqual({ resolved: true, finding: null });
    expect(await findings(node.admin())).toEqual([]);
    await node
      .admin()
      .post(`/v1/data-quality/findings/${body.id}/recheck`)
      .expect(404);
  });

  it('runs one scan at a time', async () => {
    await item({ title: 'One' });
    const first = await node.admin().post('/v1/data-quality/scans');
    const second = await node.admin().post('/v1/data-quality/scans');
    // The first may have finished already; if not, the second waits its turn.
    expect(first.status).toBe(202);
    expect([202, 409]).toContain(second.status);
    if (second.status === 409) {
      expect(second.body.code).toBe('scan_running');
    }
  });
});
