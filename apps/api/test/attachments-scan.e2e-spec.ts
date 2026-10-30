import { getQueueToken } from '@nestjs/bullmq';
import { StorageDisk } from '@nestjs/storage';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { Database } from '../src/core/database/drizzle.js';
import { auditLog } from '../src/iam/iam.tables.js';
import { ATTACHMENT_IMAGES } from '../src/platform/attachments/attachment-images.queue.js';
import { ATTACHMENT_SCAN } from '../src/platform/attachments/attachment-scan.queue.js';
import { AttachmentScanRetryJob } from '../src/platform/attachments/attachment-scan-retry.job.js';
import {
  AttachmentScanService,
  RETRY_MS,
} from '../src/platform/attachments/attachment-scan.service.js';
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
    scanner.enabled = true;
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
    contentType = 'text/plain',
  ) =>
    editor.agent
      .post(`/v1/test-items/${noteId}/attachments`)
      .attach('file', file, { filename, contentType });

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

  it('lets the uploader remove a pending file', async () => {
    const { editor, note } = await noteOfEditor();
    scanner.down = true;
    const pending = await upload(editor, note.id, TEXT, 'later.txt').expect(
      201,
    );
    await editor.agent.delete(`/v1/attachments/${pending.body.id}`).expect(204);
    await editor.agent
      .get(`/v1/attachments/${pending.body.id}/download`)
      .expect(404);
  });

  it('queues a scan that never finished again within minutes, not at the nightly sweep', async () => {
    const { editor, note } = await noteOfEditor();
    const queue = node.app.get<Queue>(getQueueToken(ATTACHMENT_SCAN));
    scanner.down = true;
    const stuck = await upload(editor, note.id, TEXT, 'stuck.txt').expect(201);
    // Its job is lost once its first attempt failed (a Redis without persistence restarted).
    await vi.waitFor(
      async () => {
        expect(
          await (await queue.getJob(`${stuck.body.id}-v1`))?.getState(),
        ).toBe('delayed');
      },
      { timeout: 10_000, interval: 100 },
    );
    await queue.remove(stuck.body.id);
    scanner.down = false;

    const retry = node.app.get(AttachmentScanRetryJob);
    const retryJob = (at: Date) =>
      queue.getJob(
        `${stuck.body.id}-v1-${Math.floor(at.getTime() / RETRY_MS)}`,
      );
    // Just uploaded: not yet (its own job may still be on its way).
    const now = new Date();
    await retry.run(now);
    expect(await retryJob(now)).toBeUndefined();
    expect(await statusOf(stuck.body.id)).toBe('pending');

    // Five minutes on, the next run of the job queues it again.
    const scansBefore = scanner.scanned;
    const later = new Date(now.getTime() + RETRY_MS + 1000);
    expect(await retry.run(later)).toBeGreaterThanOrEqual(1);
    expect(await retryJob(later)).toBeDefined();
    await vi.waitFor(
      async () => {
        expect(await statusOf(stuck.body.id)).toBe('clean');
      },
      { timeout: 20_000, interval: 250 },
    );
    expect(scanner.scanned).toBeGreaterThan(scansBefore);
    expect(
      await node.app.get(StorageDisk).exists(await keyOf(stuck.body.id)),
    ).toBe(true);
  });

  it('releases the uploads still pending when scanning is switched back off', async () => {
    const { editor, note } = await noteOfEditor();
    scanner.down = true;
    const pending = await upload(editor, note.id, TEXT, 'off.txt').expect(201);
    expect(pending.body.scanStatus).toBe('pending');
    await editor.agent
      .get(`/v1/attachments/${pending.body.id}/download`)
      .expect(409);

    scanner.enabled = false; // MALWARE_SCANNER=off, restarted
    // A queued scan ends quietly: it is not a failed scan to try again.
    const scanned = scanner.scanned;
    expect(
      await node.app
        .get(AttachmentScanService)
        .scan({ tenantId: node.tenantId, attachmentId: pending.body.id }),
    ).toBe('skipped');
    expect(scanner.scanned).toBe(scanned);
    expect(await statusOf(pending.body.id)).toBe('pending');

    // The retry job releases what nothing will scan any more.
    expect(
      await node.app.get(AttachmentScanRetryJob).run(),
    ).toBeGreaterThanOrEqual(1);
    expect(await statusOf(pending.body.id)).toBe('clean');
    await editor.agent
      .get(`/v1/attachments/${pending.body.id}/download`)
      .expect(302);
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'attachments.released'));
    const released = entries.find((entry) =>
      (entry.details as { attachments: string[] }).attachments.includes(
        pending.body.id,
      ),
    );
    expect(released?.actor).toBe('system:attachment-scan');
    expect(released?.details).toMatchObject({ reason: 'scanner_off' });
  });

  describe('uploaded images (IMAGE_PROCESSING)', () => {
    /** A real picture with a camera's EXIF, which the image job strips. */
    const photo = () =>
      sharp({
        create: {
          width: 120,
          height: 80,
          channels: 3,
          background: { r: 20, g: 90, b: 200 },
        },
      })
        .withExif({ IFD0: { Make: 'ACME' } })
        .jpeg()
        .toBuffer();

    const imageJob = (id: string) =>
      node.app.get<Queue>(getQueueToken(ATTACHMENT_IMAGES)).getJob(`${id}-v1`);

    const renditionStatusOf = async (id: string) => {
      const [row] = await db
        .select({ status: attachments.renditionStatus })
        .from(attachments)
        .where(eq(attachments.id, id));
      return row?.status;
    };

    it('processes an image only once its scan found it clean', async () => {
      const { editor, note } = await noteOfEditor();
      scanner.down = true; // the scan fails and is tried again, so the state can be seen
      const added = await upload(
        editor,
        note.id,
        await photo(),
        'held.jpg',
        'image/jpeg',
      ).expect(201);
      expect(added.body).toMatchObject({
        scanStatus: 'pending',
        renditionStatus: 'pending',
      });
      // Held back: no job, and the retry job leaves it to the scan.
      expect(await imageJob(added.body.id)).toBeUndefined();
      await editor.agent
        .get(`/v1/attachments/${added.body.id}/download?rendition=thumb`)
        .expect(409);

      scanner.down = false;
      await vi.waitFor(
        async () => {
          expect(await renditionStatusOf(added.body.id)).toBe('ready');
        },
        { timeout: 30_000, interval: 250 },
      );
      expect(await statusOf(added.body.id)).toBe('clean');
      await editor.agent
        .get(`/v1/attachments/${added.body.id}/download?rendition=thumb`)
        .expect(302);
    });

    it('never processes an infected image: it is deleted at once', async () => {
      const { editor, note } = await noteOfEditor();
      // A JPEG with the test signature after its data: still a JPEG, and infected.
      const infected = Buffer.concat([
        await photo(),
        Buffer.from(`\n${EICAR}\n`),
      ]);
      const added = await upload(
        editor,
        note.id,
        infected,
        'eicar.jpg',
        'image/jpeg',
      ).expect(201);
      await vi.waitFor(
        async () => {
          expect(
            await db
              .select()
              .from(attachments)
              .where(eq(attachments.id, added.body.id)),
          ).toHaveLength(0);
        },
        { timeout: 15_000, interval: 250 },
      );
      expect(await imageJob(added.body.id)).toBeUndefined();
    });

    it('processes the images that are released when scanning is switched back off', async () => {
      const { editor, note } = await noteOfEditor();
      scanner.down = true;
      const added = await upload(
        editor,
        note.id,
        await photo(),
        'released.jpg',
        'image/jpeg',
      ).expect(201);
      expect(added.body.renditionStatus).toBe('pending');

      scanner.enabled = false; // MALWARE_SCANNER=off, restarted
      expect(
        await node.app.get(AttachmentScanRetryJob).run(),
      ).toBeGreaterThanOrEqual(1);
      expect(await statusOf(added.body.id)).toBe('clean');
      await vi.waitFor(
        async () => {
          expect(await renditionStatusOf(added.body.id)).toBe('ready');
        },
        { timeout: 20_000, interval: 250 },
      );
    });
  });

  async function statusOf(id: string) {
    const [row] = await db
      .select({ status: attachments.scanStatus })
      .from(attachments)
      .where(eq(attachments.id, id));
    return row?.status;
  }

  async function keyOf(id: string) {
    const [row] = await db
      .select({ key: attachments.key })
      .from(attachments)
      .where(eq(attachments.id, id));
    return row!.key;
  }
});
