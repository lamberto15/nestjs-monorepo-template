import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../src/core/database/drizzle.js';
import { SystemContext } from '../src/iam/access/system-context.js';
import { ecbDocument } from '../src/platform/money/ecb-document.testing.js';
import { parseEcbRates } from '../src/platform/money/ecb-rates.js';
import { ExchangeRatesJob } from '../src/platform/money/exchange-rates.job.js';
import { ExchangeRatesService } from '../src/platform/money/exchange-rates.service.js';
import { Money } from '../src/platform/money/money.js';
import { exchangeRates } from '../src/platform/money/money.tables.js';
import { EXCHANGE_RATES_JOB } from '../src/platform/platform.jobs.js';
import { bootApp, type TestApp } from './support.js';

/**
 * A stand-in for the ECB's eurofxref documents on loopback (the tests never
 * reach the real one), started before AppModule loads: this file's apps
 * fetch from it (EXCHANGE_RATES_FETCH=on; off in every other file,
 * setup-env.ts). It serves what `documents` holds, or 503 while `down`,
 * and records what it was asked. It also turns /metrics on.
 */
const ecb = await vi.hoisted(async () => {
  const { createServer } = await import('node:http');
  const documents: Record<string, string> = {};
  const requests: string[] = [];
  const state = { down: false };
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const name = /^\/stats\/eurofxref\/([\w-]+\.xml)$/.exec(req.url ?? '')?.[1];
    if (state.down) {
      res.writeHead(503).end('maintenance');
      return;
    }
    if (!name || !documents[name]) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/xml' }).end(documents[name]);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const scrapeKey = ['money', 'scrape', String(port)].join('-');
  Object.assign(process.env, {
    EXCHANGE_RATES_FETCH: 'on',
    EXCHANGE_RATES_ECB_URL: `http://127.0.0.1:${port}/stats/eurofxref`,
    METRICS_TOKEN: scrapeKey,
  });
  return {
    documents,
    requests,
    state,
    scrapeKey,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
});

describe('money and exchange rates (e2e)', () => {
  let node: TestApp;
  let db: Database;

  beforeAll(async () => {
    node = await bootApp();
    db = node.db;
  });
  afterAll(async () => {
    await node.close();
    await ecb.close();
  });

  const job = () => node.app.get(ExchangeRatesJob);
  const rates = () => node.app.get(ExchangeRatesService);
  const scrape = async () =>
    (
      await node
        .http()
        .get('/metrics')
        .set('Authorization', `Bearer ${ecb.scrapeKey}`)
        .expect(200)
    ).text;

  // Thursday 2026-10-15, after the ECB published (15:00 UTC).
  const THURSDAY = new Date('2026-10-15T15:07:00Z');
  const HISTORY = ecbDocument({
    '2026-10-14': { USD: '1.1601', JPY: '174.90', GBP: '0.8650' },
    '2026-10-13': { USD: '1.1599', JPY: '174.10', GBP: '0.8640' },
    '2026-10-09': { USD: '1.1500', JPY: '173.00', GBP: '0.8600' },
  });
  const DAILY = ecbDocument({
    '2026-10-15': { USD: '1.1652', JPY: '175.32', GBP: '0.8689' },
  });

  it('answers 404 and 422 before any rate is stored, and the age gauge reads +Inf', async () => {
    const none = await node.admin().get('/v1/money/rates').expect(404);
    expect(none.body.code).toBe('rates_unavailable');
    const convert = await node
      .admin()
      .get('/v1/money/convert?amount=10&currency=USD&to=EUR')
      .expect(422);
    expect(convert.body).toMatchObject({ code: 'rate_unavailable' });
    expect(await scrape()).toMatch(/^exchange_rates_age_seconds \+Inf$/m);
  });

  it('keeps what it has when the ECB is down: the run reports the failure, the next one retries', async () => {
    ecb.state.down = true;
    try {
      expect(await job().run(THURSDAY)).toMatchObject({
        status: 'failed',
        newest: null,
      });
    } finally {
      ecb.state.down = false;
    }
    expect(await rates().newestDay()).toBeNull();
  });

  it('fetches the 90-day history first, as the system principal of its job', async () => {
    ecb.documents['eurofxref-hist-90d.xml'] = HISTORY;
    ecb.requests.length = 0;
    const run = vi.spyOn(node.app.get(SystemContext), 'run');
    try {
      // Wednesday after 15:00: the 14th is expected, nothing stored yet.
      expect(await job().run(new Date('2026-10-14T16:07:00Z'))).toEqual({
        status: 'fetched',
        newest: '2026-10-14',
        days: 3,
        rows: 9,
      });
      expect(run).toHaveBeenCalledWith(
        EXCHANGE_RATES_JOB,
        expect.any(Function),
        { transaction: false },
      );
    } finally {
      run.mockRestore();
    }
    expect(ecb.requests).toEqual(['/stats/eurofxref/eurofxref-hist-90d.xml']);
    // Up to date: no second request.
    expect(await job().run(new Date('2026-10-14T17:07:00Z'))).toEqual({
      status: 'current',
      newest: '2026-10-14',
    });
    expect(ecb.requests).toHaveLength(1);
  });

  it('then takes the daily document, and stores an ECB correction over the old rate', async () => {
    ecb.documents['eurofxref-daily.xml'] = DAILY;
    expect(await job().run(THURSDAY)).toMatchObject({
      status: 'fetched',
      newest: '2026-10-15',
      days: 1,
    });
    expect(ecb.requests.at(-1)).toBe('/stats/eurofxref/eurofxref-daily.xml');

    const usdOn15th = async () =>
      (
        await db
          .select()
          .from(exchangeRates)
          .where(
            and(
              eq(exchangeRates.day, '2026-10-15'),
              eq(exchangeRates.currency, 'USD'),
            ),
          )
      )[0];
    expect(await usdOn15th()).toMatchObject({
      source: 'ecb',
      base: 'EUR',
      rate: '1.1652',
    });
    // The ECB corrects a day it published: the next fetch of it stores the new value.
    // Only the corrected row is written; the same document again writes none.
    const corrected = parseEcbRates(
      ecbDocument({
        '2026-10-15': { USD: '1.1655', JPY: '175.32', GBP: '0.8689' },
      }),
    );
    expect(await rates().store(corrected)).toBe(1);
    expect(await rates().store(corrected)).toBe(0);
    expect((await usdOn15th()).rate).toBe('1.1655');
    // Back to the published value for the rest of the file.
    expect(await rates().store(parseEcbRates(DAILY))).toBe(1);
  });

  it('serves a day’s rates: the newest working day on or before the date, as strings, with an ETag', async () => {
    const today = await node
      .admin()
      .get('/v1/money/rates?date=2026-10-15')
      .expect(200);
    expect(today.body).toEqual({
      source: 'ecb',
      base: 'EUR',
      day: '2026-10-15',
      rates: { GBP: '0.8689', JPY: '175.32', USD: '1.1652' },
    });
    // A weekend (and the gap of the 10th to the 12th) takes the working day before.
    const sunday = await node
      .admin()
      .get('/v1/money/rates?date=2026-10-11')
      .expect(200);
    expect(sunday.body.day).toBe('2026-10-09');
    expect(sunday.body.rates.USD).toBe('1.1500');
    // Before the first day: none.
    await node.admin().get('/v1/money/rates?date=2026-01-01').expect(404);
    await node.admin().get('/v1/money/rates?date=yesterday').expect(400);
    // Unchanged: 304.
    await node
      .admin()
      .get('/v1/money/rates?date=2026-10-15')
      .set('If-None-Match', today.headers.etag)
      .expect(304);
  });

  it('converts through the euro with one rounding, and says at which rate, day and source', async () => {
    const res = await node
      .admin()
      .get('/v1/money/convert?amount=10&currency=USD&to=JPY&date=2026-10-15')
      .expect(200);
    // 10 / 1.1652 × 175.32 = 1504.634…
    expect(res.body).toEqual({
      from: { amount: '10.00', currency: 'USD' },
      amount: { amount: '1505', currency: 'JPY' },
      rate: '150.4634397528',
      rateDate: '2026-10-15',
      source: 'ecb',
      base: 'EUR',
      legs: { from: '1.1652', to: '175.32' },
      rounding: 'half-up',
    });

    // From the base, at the rates of a past day (a Monday with none: the Friday before).
    const eur = await node
      .admin()
      .get('/v1/money/convert?amount=-100&currency=EUR&to=GBP&date=2026-10-12')
      .expect(200);
    expect(eur.body).toMatchObject({
      amount: { amount: '-86.00', currency: 'GBP' },
      rateDate: '2026-10-09',
      legs: { from: '1', to: '0.8600' },
    });

    // 1.00 EUR at 0.8689 GBP: 0.87 half-up, 0.86 rounded down.
    const down = await node
      .admin()
      .get(
        '/v1/money/convert?amount=1&currency=EUR&to=GBP&date=2026-10-15&rounding=down',
      )
      .expect(200);
    expect(down.body.amount).toEqual({ amount: '0.86', currency: 'GBP' });
    expect(down.body.rounding).toBe('down');

    // The same currency: unchanged, at 1.
    const same = await node
      .admin()
      .get('/v1/money/convert?amount=5&currency=JPY&to=JPY')
      .expect(200);
    expect(same.body).toMatchObject({
      amount: { amount: '5', currency: 'JPY' },
      rate: '1',
      source: 'identity',
    });
  });

  it('refuses what it can’t convert exactly, with a problem in the request’s language', async () => {
    const precision = await node
      .admin()
      .get('/v1/money/convert?amount=12.345&currency=EUR&to=USD')
      .expect(400);
    expect(precision.body.code).toBe('validation_failed');
    expect(precision.body.errors[0].path).toBe('amount');

    const unknown = await node
      .admin()
      .get('/v1/money/convert?amount=1&currency=EUR&to=XAU')
      .expect(400);
    expect(unknown.body.errors[0].path).toBe('to');
    await node
      .admin()
      .get('/v1/money/convert?amount=1e3&currency=EUR&to=USD')
      .expect(400);
    await node
      .admin()
      .get('/v1/money/convert?amount=1&currency=EUR&to=USD&rounding=nearest')
      .expect(400);

    // The ECB doesn't publish dirhams.
    const aed = await node
      .admin()
      .get('/v1/money/convert?amount=1&currency=AED&to=EUR&lang=de')
      .expect(422);
    expect(aed.body).toMatchObject({ code: 'rate_unavailable' });
    expect(aed.body.detail).toMatch(/Kein Wechselkurs für AED/);
    expect(aed.headers['content-language']).toBe('de');
  });

  it('lets any signed-in user or API client read rates, and nobody else', async () => {
    await node.http().get('/v1/money/rates').expect(401);
    const viewer = await node.user(['viewer']);
    await viewer.agent.get('/v1/money/rates?date=2026-10-15').expect(200);
    const client = await node.client(`money-${randomUUID().slice(0, 8)}`);
    await node
      .http()
      .get('/v1/money/convert?amount=1&currency=EUR&to=USD&date=2026-10-15')
      .set('Authorization', client.auth)
      .expect(200);
  });

  it('exposes how old the newest rates are, and lists its job in the catalog', async () => {
    const age = /^exchange_rates_age_seconds (\d+(\.\d+)?(e\+\d+)?)$/m.exec(
      await scrape(),
    );
    expect(age).not.toBeNull();
    const expected = (Date.now() - Date.parse('2026-10-15T00:00:00Z')) / 1000;
    expect(Math.abs(Number(age![1]) - expected)).toBeLessThan(60);

    const catalog = await node.admin().get('/v1/access/catalog').expect(200);
    expect(
      (catalog.body.systemJobs as { key: string }[]).find(
        (each) => each.key === 'exchange-rates',
      ),
    ).toMatchObject({ actor: 'system:exchange-rates', permissions: [] });
  });

  it('throws the library’s errors in services, for the problem-details filter to map', async () => {
    await expect(
      rates().convert(Money.of('1', 'AED'), 'USD', { day: '2026-10-15' }),
    ).rejects.toMatchObject({ code: 'rate_unavailable' });
    const converted = await rates().convert(Money.of('100', 'USD'), 'EUR', {
      day: '2026-10-15',
      rounding: 'half-even',
    });
    // 100 / 1.1652 = 85.8221…
    expect(converted.amount.toJSON()).toEqual({
      amount: '85.82',
      currency: 'EUR',
    });
    expect(converted).toMatchObject({ rateDate: '2026-10-15', source: 'ecb' });
  });
});
