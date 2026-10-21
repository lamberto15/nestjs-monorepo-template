import { StorageDisk } from '@nestjs/storage';
import { eq } from 'drizzle-orm';
import type { Database } from '../src/core/database/drizzle.js';
import { auditLog } from '../src/iam/iam.tables.js';
import { AttachmentSweepJob } from '../src/platform/attachments/attachment-sweep.job.js';
import { attachments } from '../src/platform/attachments/attachments.tables.js';
import {
  EICAR,
  MalwareScanner,
  type MemoryMalwareScanner,
} from '../src/platform/attachments/malware-scanner.js';
import { MetricsService } from '../src/core/metrics/metrics.service.js';
import { bootApp, type TestApp } from './support.js';

// The in-memory scanner (flags the EICAR string): read when AppModule loads.
vi.hoisted(() => {
  process.env.MALWARE_SCANNER = 'memory';
});

const TEXT = Buffer.from('Minutes of the meeting\n');
const INFECTED = Buffer.from(`${EICAR}\n`);

describe('attachment malware scanning (e2e, MALWARE_SCANNER=memory)', () => {
  let node: TestApp;
  let db: Database;
  let scanner: MemoryMalwareScanner;

  beforeAll(async () => {
    node = await bootApp();
    db = node.db;
    scanner = node.app.get(MalwareScanner) as MemoryMalwareScanner;
  });
  afterAll(async () => {
    await node.close();
  });
  afterEach(() => {
    scanner.down = false;
  });

  async function noteOfEditor() {
    const editor = await node.user(['editor']);
    const note = (
      await node
        .writeItem(editor.agent, { title: 'Scanned', body: 'x' })
        .expect(201)
    ).body as { id: string };
    return { editor, note };
  }

  const upload = (
    editor: Awaited<ReturnType<typeof noteOfEditor>>['editor'],
    noteId: string,
    file: Buffer,
    filename: string,
  ) =>
    editor.agent
      .post(`/v1/test-items/${noteId}/attachments`)
      .attach('file', file, { filename, contentType: 'text/plain' });

  const metric = async (result: string) => {
    const { body } = await node.app.get(MetricsService).scrape();
    const line = body
      .split('\n')
      .find((l) =>
        l.startsWith(`attachments_scanned_total{result="${result}"`),
      );
    return line ? Number(line.split(' ').pop()) : 0;
  };

  it('keeps an upload pending (no download) until its scan finds it clean', async () => {
    const { editor, note } = await noteOfEditor();
    scanner.down = true; // the scan fails and is tried again, so the state can be seen
    const clean = await upload(editor, note.id, TEXT, 'minutes.txt').expect(
      201,
    );
    expect(clean.body.scanStatus).toBe('pending');

    const refused = await editor.agent
      .get(`/v1/attachments/${clean.body.id}/download`)
      .expect(409);
    expect(refused.body.code).toBe('attachment_scan_pending');
    const listed = await editor.agent
      .get(`/v1/test-items/${note.id}/attachments?scanStatus=pending`)
      .expect(200);
    expect(listed.body.items).toHaveLength(1);

    scanner.down = false; // the next attempt (backoff 5 s) finds it clean
    await vi.waitFor(
      async () => {
        const [row] = await db
          .select()
          .from(attachments)
          .where(eq(attachments.id, clean.body.id));
        expect(row!.scanStatus).toBe('clean');
      },
      { timeout: 20_000, interval: 250 },
    );
    await editor.agent
      .get(`/v1/attachments/${clean.body.id}/download`)
      .expect(302);
    expect(await metric('clean')).toBeGreaterThan(0);
    expect(await metric('error')).toBeGreaterThan(0);
  });

  it('deletes an infected upload (row and file), audits it, and tells the uploader', async () => {
    const { editor, note } = await noteOfEditor();
    const infected = await upload(
      editor,
      note.id,
      INFECTED,
      'eicar.txt',
    ).expect(201);
    expect(infected.body.scanStatus).toBe('pending');

    await vi.waitFor(
      async () => {
        const rows = await db
          .select()
          .from(attachments)
          .where(eq(attachments.id, infected.body.id));
        expect(rows).toHaveLength(0);
      },
      { timeout: 15_000, interval: 250 },
    );
    await editor.agent
      .get(`/v1/attachments/${infected.body.id}/download`)
      .expect(404);
    const listed = await editor.agent
      .get(`/v1/test-items/${note.id}/attachments`)
      .expect(200);
    expect(listed.body.items).toEqual([]);

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, infected.body.id));
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'attachment.added',
      'attachment.rejected',
    ]);
    const rejected = entries.find((e) => e.action === 'attachment.rejected')!;
    expect(rejected.actor).toBe('system:attachment-scan');
    expect(rejected.details).toMatchObject({
      name: 'eicar.txt',
      signature: 'Eicar-Test-Signature',
      uploadedBy: `user:${editor.id}`,
    });

    const notifications = (
      await editor.agent.get('/v1/notifications').expect(200)
    ).body.items as { type: string; data: Record<string, unknown> }[];
    expect(
      notifications.find((n) => n.type === 'attachment.rejected')?.data,
    ).toMatchObject({ name: 'eicar.txt', signature: 'Eicar-Test-Signature' });
    expect(await metric('infected')).toBeGreaterThan(0);
  });

  it('lets the uploader remove a pending file, and the sweep queues the scans that never ran', async () => {
    const { editor, note } = await noteOfEditor();
    scanner.down = true;
    const pending = await upload(editor, note.id, TEXT, 'later.txt').expect(
      201,
    );
    await editor.agent.delete(`/v1/attachments/${pending.body.id}`).expect(204);

    const stuck = await upload(editor, note.id, TEXT, 'stuck.txt').expect(201);
    scanner.down = false;
    // Made old, as if its job had been lost.
    await db
      .update(attachments)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(attachments.id, stuck.body.id));
    await node.app.get(AttachmentSweepJob).run();
    await vi.waitFor(
      async () => {
        const [row] = await db
          .select()
          .from(attachments)
          .where(eq(attachments.id, stuck.body.id));
        expect(row!.scanStatus).toBe('clean');
      },
      { timeout: 20_000, interval: 250 },
    );
    expect(
      await node.app.get(StorageDisk).exists(await keyOf(stuck.body.id)),
    ).toBe(true);
  });

  async function keyOf(id: string) {
    const [row] = await db
      .select({ key: attachments.key })
      .from(attachments)
      .where(eq(attachments.id, id));
    return row!.key;
  }
});
