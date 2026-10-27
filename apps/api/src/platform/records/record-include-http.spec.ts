import {
  Controller,
  Get,
  NotFoundException,
  Query,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { field } from '../fields/field.js';
import { defineRecord } from './record.js';
import { IncludePipe, type RecordInclude } from './record-can.js';
import { RECORD_DECLARATION } from './record-declaration.token.js';

const declare = (capabilities: ('watch' | 'tags')[]) =>
  defineRecord({
    subject: 'Invoice',
    path: 'invoice-lines',
    apiTag: 'invoice-lines',
    className: 'InvoiceIncludeHttpSpec',
    noun: 'invoice line',
    table: 'invoice_lines',
    softDelete: false,
    unit: false,
    fields: { title: field.string() },
    capabilities,
  });

/** A record route's load, which would be a 404 here: the include is judged first. */
@Controller('lines')
class LinesController {
  @Get(':id')
  get(@Query('include', IncludePipe) _include: RecordInclude) {
    throw new NotFoundException();
  }
}

const boot = async (capabilities: ('watch' | 'tags')[]) => {
  const module = await Test.createTestingModule({
    controllers: [LinesController],
    providers: [
      { provide: RECORD_DECLARATION, useValue: declare(capabilities) },
    ],
  }).compile();
  const app = module.createNestApplication();
  await app.init();
  return app;
};

/** `?include=watching` on a feature without the watch capability (the route through the pipe). */
describe('?include=watching on the routes of a record', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app.close();
  });

  it('is a 400 before the record is loaded when it cannot be watched; can alone still works', async () => {
    app = await boot(['tags']);
    const res = await request(app.getHttpServer())
      .get('/lines/1?include=watching')
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('cannot be watched');
    await request(app.getHttpServer())
      .get('/lines/1?include=can,watching')
      .expect(400);
    // Past the pipe: the route's own 404.
    await request(app.getHttpServer()).get('/lines/1?include=can').expect(404);
    await request(app.getHttpServer()).get('/lines/1').expect(404);
  });

  it('reaches the route with the watch capability', async () => {
    app = await boot(['watch']);
    await request(app.getHttpServer())
      .get('/lines/1?include=can,watching')
      .expect(404);
    await request(app.getHttpServer())
      .get('/lines/1?include=nonsense')
      .expect(400);
  });
});
