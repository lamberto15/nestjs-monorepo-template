import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import type request from 'supertest';
import { bootApp, connect, type TestApp } from './support.js';

/** The path and query of a signed URL: the tests reach the app on its own port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

describe('platform: queues, storage and realtime (e2e)', () => {
  let node: TestApp;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await node.close();
  });

  it('authenticates realtime connections, and refuses anonymous ones', async () => {
    const client = await node.client();
    const socket = await connect(node, client.key);
    sockets.push(socket);
    const me = await socket.emitWithAck('whoami');
    expect(me).toEqual({
      kind: 'client',
      id: client.id,
      tenantId: node.tenantId,
      rooms: [`tenant:${node.tenantId}:principal:client:${client.id}`],
    });

    const { port } = node.app.getHttpServer().address() as AddressInfo;
    const anonymous = io(`http://127.0.0.1:${port}/realtime`, {
      transports: ['websocket'],
    });
    sockets.push(anonymous);
    // Refused at the handshake: never connected, and not retried.
    const refused = await new Promise<Error>((resolve) =>
      anonymous.once('connect_error', resolve),
    );
    expect(refused.message).toBe('unauthorized');
    expect(anonymous.connected).toBe(false);
    expect(anonymous.active).toBe(false);
  });

  it('puts a connection in its room before it hears it is connected', async () => {
    // A message sent the moment the connection opens (and events sent to the
    // principal then) must find the room joined: once a race, now by design.
    const client = await node.client();
    for (let round = 0; round < 20; round++) {
      const socket = await connect(node, client.key);
      sockets.push(socket);
      const me = await socket.emitWithAck('whoami');
      expect(me.rooms).toEqual([
        `tenant:${node.tenantId}:principal:client:${client.id}`,
      ]);
    }
  });

  /** Waits until the transfer is done, and returns its status. */
  async function finished(auth: string | request.Agent, id: string) {
    for (let tries = 0; tries < 100; tries++) {
      const status = await (
        typeof auth === 'string'
          ? node
              .http()
              .get(`/v1/data/transfers/${id}`)
              .set('Authorization', auth)
          : auth.get(`/v1/data/transfers/${id}`)
      ).expect(200);
      if (
        status.body.status === 'completed' ||
        status.body.status === 'failed'
      ) {
        return status.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The transfer never finished');
  }

  it('exports data as CSV, JSON and Excel in a worker, and says so over realtime', async () => {
    const owner = await node.client();
    await node
      .writeItem(owner.auth, { title: 'First, with a comma', body: 'one' })
      .expect(201);
    await node
      .writeItem(owner.auth, { title: 'Second', body: 'two' })
      .expect(201);
    const other = await node.client();
    await node
      .writeItem(other.auth, { title: 'Not mine', body: 'x' })
      .expect(201);

    const catalog = await node
      .http()
      .get('/v1/data')
      .set('Authorization', owner.auth)
      .expect(200);
    expect(catalog.body.exports.map((e: { name: string }) => e.name)).toContain(
      'test-items',
    );

    const socket = await connect(node, owner.key);
    sockets.push(socket);
    const ready = new Promise<{ id: string; rows: number; url: string }>(
      (resolve) => socket.once('data.export-ready', resolve),
    );
    const csv = await node
      .http()
      .post('/v1/data/exports')
      .set('Authorization', owner.auth)
      .send({ name: 'test-items', format: 'csv' })
      .expect(202);
    expect((await ready).id).toBe(csv.body.id);
    const done = await finished(owner.auth, csv.body.id);
    expect(done).toMatchObject({
      kind: 'export',
      status: 'completed',
      result: { rows: 2 },
    });
    const file = await node.http().get(local(done.result.url)).expect(200);
    expect(file.text).toContain('"First, with a comma"');
    expect(file.text).not.toContain('Not mine');

    const json = await node
      .http()
      .post('/v1/data/exports')
      .set('Authorization', owner.auth)
      .send({
        name: 'test-items',
        format: 'json',
        filters: { 'title.contains': 'second' },
      })
      .expect(202);
    const jsonDone = await finished(owner.auth, json.body.id);
    const exported = (
      await node.http().get(local(jsonDone.result.url)).expect(200)
    ).body;
    expect(exported.map((n: { title: string }) => n.title)).toEqual(['Second']);

    const xlsx = await node
      .http()
      .post('/v1/data/exports')
      .set('Authorization', owner.auth)
      .send({ name: 'test-items', format: 'xlsx' })
      .expect(202);
    const xlsxDone = await finished(owner.auth, xlsx.body.id);
    const sheet = await node
      .http()
      .get(local(xlsxDone.result.url))
      .responseType('blob')
      .expect(200);
    expect(sheet.body.subarray(0, 2).toString()).toBe('PK'); // a zip: an .xlsx

    await node
      .http()
      .post('/v1/data/exports')
      .set('Authorization', owner.auth)
      .send({ name: 'test-items', filters: { nope: '1' } })
      .expect(400);
    await node
      .http()
      .post('/v1/data/exports')
      .set('Authorization', owner.auth)
      .send({ name: 'nothing' })
      .expect(404);
    // Someone else's transfer: 404.
    await node
      .http()
      .get(`/v1/data/transfers/${csv.body.id}`)
      .set('Authorization', other.auth)
      .expect(404);
  });

  it('exports with date filters, and neutralizes formulas in CSV', async () => {
    const owner = await node.client();
    await node
      .writeItem(owner.auth, { title: '=1+1', body: '@cmd' })
      .expect(201);

    // A date filter is parsed again by the worker (the job carries JSON).
    const dated = await node
      .http()
      .post('/v1/data/exports')
      .set('Authorization', owner.auth)
      .send({
        name: 'test-items',
        format: 'csv',
        filters: { 'createdAt.gte': '2000-01-01T00:00:00Z' },
      })
      .expect(202);
    const done = await finished(owner.auth, dated.body.id);
    expect(done).toMatchObject({ status: 'completed', result: { rows: 1 } });
    const file = await node.http().get(local(done.result.url)).expect(200);
    expect(file.text).toContain("'=1+1");
    expect(file.text).toContain("'@cmd");
    expect(file.text).not.toMatch(/(^|,)"?=1\+1/m);

    // A date after every test item: nothing.
    const later = await node
      .http()
      .post('/v1/data/exports')
      .set('Authorization', owner.auth)
      .send({
        name: 'test-items',
        format: 'json',
        filters: { 'createdAt.gte': '2999-01-01T00:00:00Z' },
      })
      .expect(202);
    expect(await finished(owner.auth, later.body.id)).toMatchObject({
      status: 'completed',
      result: { rows: 0 },
    });
  });

  it("writes an export's dates in the reader's time zone", async () => {
    const title = `zoned-${randomUUID().slice(0, 8)}`;
    const filters = { 'title.contains': title };
    /** The createdAt header and cell of the one exported test item. */
    const exported = async (
      auth: string | request.Agent,
      body: Record<string, unknown>,
    ) => {
      const started = await (
        typeof auth === 'string'
          ? node.http().post('/v1/data/exports').set('Authorization', auth)
          : auth.post('/v1/data/exports')
      )
        .send({ name: 'test-items', filters, ...body })
        .expect(202);
      const done = await finished(auth, started.body.id);
      expect(done).toMatchObject({ status: 'completed', result: { rows: 1 } });
      const file = await node.http().get(local(done.result.url)).expect(200);
      if (body.format === 'json') {
        const [item] = file.body as { createdAt: string }[];
        return { header: 'createdAt', cell: item!.createdAt };
      }
      const [headers, line] = file.text.replace(/^\uFEFF/, '').split('\n');
      const column = headers!
        .split(',')
        .findIndex((header) => header.startsWith('createdAt'));
      return {
        header: headers!.split(',')[column]!,
        cell: line!.split(',')[column]!,
      };
    };
    /** The moment as the wall clock of a zone `hours` ahead of UTC shows it. */
    const clock = (moment: number, hours: number) =>
      new Date(Math.floor(moment / 1000) * 1000 + hours * 3_600_000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');

    const { agent } = await node.user(['editor']);
    await agent
      .patch('/v1/auth/me')
      .send({ timezone: 'Asia/Dubai' })
      .expect(200);
    const item = await node.writeItem(agent, { title, body: 'x' }).expect(201);
    const moment = new Date(item.body.createdAt as string).getTime();

    // CSV, for people (and spreadsheets): local time, the zone in the header.
    expect(await exported(agent, { format: 'csv' })).toEqual({
      header: 'createdAt (Asia/Dubai)',
      cell: clock(moment, 4),
    });
    // JSON, for programs: the exact moment, with the offset.
    const json = await exported(agent, { format: 'json' });
    expect(json.cell.endsWith('+04:00')).toBe(true);
    expect(new Date(json.cell).getTime()).toBe(moment);
    // A zone asked for wins; a zone that doesn't exist is a 400.
    expect(
      await exported(agent, { format: 'csv', timezone: 'Asia/Kolkata' }),
    ).toEqual({
      header: 'createdAt (Asia/Kolkata)',
      cell: clock(moment, 5.5),
    });
    await agent
      .post('/v1/data/exports')
      .send({ name: 'test-items', timezone: 'Mars/Olympus' })
      .expect(400);
  });

  it('hands out an import template that imports as it is, with the columns the caller may set', async () => {
    const client = await node.client();
    const catalog = await node
      .http()
      .get('/v1/data')
      .set('Authorization', client.auth)
      .expect(200);
    const itemsImport = catalog.body.imports.find(
      (i: { name: string }) => i.name === 'test-items',
    );
    expect(itemsImport.template).toBe('/v1/data/imports/test-items/template');
    expect(itemsImport.columns.slice(0, 2)).toEqual([
      {
        name: 'title',
        type: 'text',
        required: true,
        min: 1,
        max: 200,
      },
      {
        name: 'body',
        type: 'text',
        required: false,
        max: 10_000,
      },
    ]);

    const template = await node
      .http()
      .get('/v1/data/imports/test-items/template')
      .set('Authorization', client.auth)
      .expect(200);
    expect(template.headers['content-disposition']).toBe(
      'attachment; filename="test-items-template.csv"',
    );
    const text = template.text.replace(/^\uFEFF/, '');
    expect(text).toMatch(/^title,body/);
    expect(text.split('\n')[1]).toMatch(/^text,text\n?/);
    const excel = await node
      .http()
      .get('/v1/data/imports/test-items/template?format=xlsx')
      .set('Authorization', client.auth)
      .responseType('blob')
      .expect(200);
    expect(excel.body.subarray(0, 2).toString()).toBe('PK');
    await node
      .http()
      .get('/v1/data/imports/nothing/template')
      .set('Authorization', client.auth)
      .expect(404);

    // The template, sent back unchanged: its example row is a valid row.
    for (const [format, file] of [
      ['csv', Buffer.from(template.text)],
      ['xlsx', excel.body as Buffer],
    ] as const) {
      const sent = await node
        .http()
        .post('/v1/data/imports')
        .set('Authorization', client.auth)
        .field('name', 'test-items')
        .field('dryRun', 'true')
        .attach('file', file, `template.${format}`)
        .expect(202);
      expect(await finished(client.auth, sent.body.id)).toMatchObject({
        status: 'completed',
        result: { rows: 1, imported: 1, failed: 0 },
      });
    }

    // A role that may create test items but not set their text: no body column,
    // and a file that sets it is refused row by row, as POST /test-items is.
    const titlesOnly = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `Import titles ${randomUUID().slice(0, 8)}`,
        permissions: [
          { subject: 'TestItem', action: 'read', conditions: [] },
          { subject: 'TestItem', action: 'create', conditions: [], fields: [] },
        ],
      })
      .expect(201);
    const { agent } = await node.user([titlesOnly.body.id]);
    const limited = await agent
      .get('/v1/data/imports/test-items/template')
      .expect(200);
    expect(limited.text.replace(/^\uFEFF/, '')).toMatch(/^title,code\n/);
    const refused = await agent
      .post('/v1/data/imports')
      .field('name', 'test-items')
      .attach(
        'file',
        Buffer.from('title,body\nJust a title,\nWith text,secret\n'),
        'test-items.csv',
      )
      .expect(202);
    const done = await finished(agent, refused.body.id);
    expect(done).toMatchObject({
      status: 'completed',
      result: { rows: 2, imported: 1, failed: 1 },
    });
    const report = await node
      .http()
      .get(local(done.result.errorsUrl))
      .expect(200);
    expect(report.text).toContain('2,body,You may not set this field.');
  });

  it('imports a file row by row, reports the bad rows, and can only check', async () => {
    const client = await node.client();
    const file = Buffer.from(
      'title,body\nImported one,text\n,missing title\nImported two,more\n',
    );
    const upload = (dryRun: boolean) =>
      node
        .http()
        .post('/v1/data/imports')
        .set('Authorization', client.auth)
        .field('name', 'test-items')
        .field('dryRun', String(dryRun))
        .attach('file', file, {
          filename: 'test-items.csv',
          contentType: 'text/csv',
        })
        .expect(202);

    const checked = await finished(client.auth, (await upload(true)).body.id);
    expect(checked.result).toMatchObject({
      rows: 3,
      imported: 2,
      failed: 1,
      dryRun: true,
    });
    expect(
      (
        await node
          .http()
          .get('/v1/test-items')
          .set('Authorization', client.auth)
      ).body.items,
    ).toHaveLength(0);

    const imported = await finished(client.auth, (await upload(false)).body.id);
    expect(imported.result).toMatchObject({
      rows: 3,
      imported: 2,
      failed: 1,
      dryRun: false,
    });
    const report = await node
      .http()
      .get(local(imported.result.errorsUrl))
      .expect(200);
    expect(report.text).toContain('2,title,');
    const titles = (
      await node.http().get('/v1/test-items').set('Authorization', client.auth)
    ).body.items.map((n: { title: string }) => n.title);
    expect(titles.sort()).toEqual(['Imported one', 'Imported two']);

    // An Excel file works the same.
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Test items');
    sheet.addRow(['title', 'body']);
    sheet.addRow(['From Excel', 'cell']);
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
    const fromExcel = await node
      .http()
      .post('/v1/data/imports')
      .set('Authorization', client.auth)
      .field('name', 'test-items')
      .attach('file', xlsx, { filename: 'test-items.xlsx' })
      .expect(202);
    const excelDone = await finished(client.auth, fromExcel.body.id);
    expect(excelDone).toMatchObject({
      status: 'completed',
      result: { imported: 1, failed: 0 },
    });

    // A picture is not data: refused before a byte is stored.
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await node
      .http()
      .post('/v1/data/imports')
      .set('Authorization', client.auth)
      .field('name', 'test-items')
      .attach('file', png, 'x.png')
      .expect(415);

    const queues = await node.admin().get('/v1/ops/queues').expect(200);
    expect(queues.body.items.map((q: { name: string }) => q.name)).toEqual([
      'mail',
      'data-transfers',
      'bulk',
    ]);
  });
});
