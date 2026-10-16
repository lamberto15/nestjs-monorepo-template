import type { ConfigService } from '@nestjs/config';
import { HttpClient } from '@nestjs/http-client';
import { Logger } from '@nestjs/common';
import type { SystemContext } from '../../iam/access/system-context.js';
import type { PlatformEnv } from '../platform.env.js';
import { ecbDocument } from './ecb-document.testing.js';
import type { RatesOfDay } from './ecb-rates.js';
import {
  expectedDay,
  ExchangeRatesJob,
  MAX_DOCUMENT_BYTES,
  previousWorkingDay,
  workingDaysBefore,
} from './exchange-rates.job.js';
import {
  crossConvert,
  type ExchangeRatesService,
} from './exchange-rates.service.js';
import { Money } from './money.js';
import { random } from './random.testing.js';

describe('crossConvert', () => {
  it('converts from the base, to the base, and across through it', () => {
    // 100.00 EUR at 1.1652 USD per EUR.
    expect(crossConvert(Money.of('100', 'EUR'), 'USD', '1', '1.1652')).toEqual({
      amount: Money.of('116.52', 'USD'),
      rate: '1.1652',
    });
    // 116.52 USD back: 100.00 EUR.
    expect(
      crossConvert(Money.of('116.52', 'USD'), 'EUR', '1.1652', '1').amount,
    ).toEqual(Money.of('100', 'EUR'));
    // 10.00 USD in JPY: 10 / 1.1652 × 175.32 = 1504.63096…
    const usdJpy = crossConvert(
      Money.of('10', 'USD'),
      'JPY',
      '1.1652',
      '175.32',
    );
    expect(usdJpy.amount.toDecimal()).toBe('1505');
    expect(usdJpy.rate).toBe('150.4634397528');
    // JPY (0 decimals) to KWD (3): 1505 / 175.32 × 0.3561 = 3.05683…
    expect(
      crossConvert(
        Money.of('1505', 'JPY'),
        'KWD',
        '175.32',
        '0.3561',
      ).amount.toDecimal(),
    ).toBe('3.057');
  });

  it('rounds once, by the mode asked', () => {
    // 1.00 EUR at 1.125 GBP: 1.125 exactly, a tie at the cent.
    const one = Money.of('1', 'EUR');
    expect(crossConvert(one, 'GBP', '1', '1.125').amount.toDecimal()).toBe(
      '1.13',
    );
    expect(
      crossConvert(one, 'GBP', '1', '1.125', 'half-even').amount.toDecimal(),
    ).toBe('1.12');
    expect(
      crossConvert(one.negated(), 'GBP', '1', '1.125').amount.toDecimal(),
    ).toBe('-1.13');
    expect(
      crossConvert(one, 'GBP', '1', '1.125', 'down').amount.toDecimal(),
    ).toBe('1.12');
  });

  it('refuses rates of zero or below', () => {
    expect(() => crossConvert(Money.of('1', 'EUR'), 'USD', '1', '0')).toThrow(
      RangeError,
    );
  });

  it('stays within half a minor unit of the exact result, without rounding through the base (random)', () => {
    const next = random(11);
    const codes = ['JPY', 'EUR', 'USD', 'KWD'];
    for (let i = 0; i < 2000; i++) {
      const from = next.pick(codes);
      const to = next.pick(codes);
      const amount = Money.ofMinor(
        next.bigint(10n ** 14n) * (next.int(2) ? -1n : 1n),
        from,
      );
      const rate = () =>
        `${1 + next.int(300)}.${String(next.int(10000)).padStart(4, '0')}`;
      const fromRate = from === 'EUR' ? '1' : rate();
      const toRate = to === 'EUR' ? '1' : rate();
      const result = crossConvert(amount, to, fromRate, toRate).amount;
      // exact = minor × 10^(eTo - eFrom) × toRate / fromRate; compare result × den with num.
      const f =
        BigInt(fromRate.replace('.', '')) *
        (fromRate.includes('.') ? 1n : 10_000n);
      const t =
        BigInt(toRate.replace('.', '')) * (toRate.includes('.') ? 1n : 10_000n);
      const shift = result.exponent - amount.exponent;
      let num = amount.minor * t;
      let den = f;
      if (shift >= 0) num *= 10n ** BigInt(shift);
      else den *= 10n ** BigInt(-shift);
      const diff = result.minor * den - num;
      expect(2n * (diff < 0n ? -diff : diff) <= den).toBe(true);
    }
  });
});

describe('the ECB calendar', () => {
  it('knows the working day before', () => {
    expect(previousWorkingDay('2026-10-16')).toBe('2026-10-15'); // Friday → Thursday
    expect(previousWorkingDay('2026-10-19')).toBe('2026-10-16'); // Monday → Friday
    expect(previousWorkingDay('2026-10-18')).toBe('2026-10-16'); // Sunday → Friday
  });

  it('counts working days back', () => {
    expect(workingDaysBefore('2026-10-15', 5)).toBe('2026-10-08');
    expect(workingDaysBefore('2026-10-15', 0)).toBe('2026-10-15');
  });

  it('expects today’s rates from 15:00 UTC on a weekday, else the working day before', () => {
    expect(expectedDay(new Date('2026-10-15T14:59:00Z'))).toBe('2026-10-14');
    expect(expectedDay(new Date('2026-10-15T15:00:00Z'))).toBe('2026-10-15');
    expect(expectedDay(new Date('2026-10-17T18:00:00Z'))).toBe('2026-10-16'); // Saturday
    expect(expectedDay(new Date('2026-10-19T09:00:00Z'))).toBe('2026-10-16'); // Monday morning
  });
});

describe('ExchangeRatesJob', () => {
  const BASE = 'https://ecb.test/stats/eurofxref';
  const DAILY = ecbDocument({ '2026-10-15': { USD: '1.1652', JPY: '175.32' } });
  const HISTORY = ecbDocument({
    '2026-10-15': { USD: '1.1652' },
    '2026-10-14': { USD: '1.1601' },
    '2026-10-13': { USD: '1.1599' },
  });

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const xml = (body: string) =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/xml' },
    });

  /** Serves `documents` by file name (404 for any other). */
  const serve =
    (documents: Record<string, string>) =>
    (url: string): Response => {
      const name = url.split('/').at(-1)!;
      return documents[name]
        ? xml(documents[name])
        : new Response('', { status: 404 });
    };

  /**
   * The job against a fake fetch and a fake store that keeps the newest
   * day it was given (as the table does).
   */
  function job({
    newest,
    respond,
    fetchOn = true,
    storeFails,
  }: {
    newest: string | null;
    respond: (url: string) => Response;
    fetchOn?: boolean;
    storeFails?: Error;
  }) {
    const asked: string[] = [];
    const stored: RatesOfDay[][] = [];
    const state = { newest };
    const fetch = (async (input: Request | string | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      asked.push(url.slice(BASE.length + 1));
      return respond(url);
    }) as typeof globalThis.fetch;
    const http = new HttpClient({ baseUrl: BASE, fetch, retry: false });
    const rates = {
      newestDay: async () => state.newest,
      store: async (days: RatesOfDay[]) => {
        if (storeFails) {
          throw storeFails;
        }
        stored.push(days);
        for (const { day } of days) {
          if (!state.newest || day > state.newest) {
            state.newest = day;
          }
        }
        return days.reduce((n, d) => n + Object.keys(d.rates).length, 0);
      },
    } as unknown as ExchangeRatesService;
    const config = {
      get: () => fetchOn,
    } as unknown as ConfigService<PlatformEnv, true>;
    const system = {
      run: (_job: unknown, work: () => Promise<unknown>) => work(),
    } as unknown as SystemContext;
    return {
      run: (now: Date) =>
        new ExchangeRatesJob(http, rates, config, system).refresh(now),
      asked,
      stored,
    };
  }

  it('does nothing while the expected day is stored, or when off', async () => {
    const current = job({ newest: '2026-10-15', respond: () => xml(DAILY) });
    expect(await current.run(new Date('2026-10-15T16:07:00Z'))).toEqual({
      status: 'current',
      newest: '2026-10-15',
    });
    // Thursday's rates on Friday morning: still current.
    expect(await current.run(new Date('2026-10-16T10:07:00Z'))).toMatchObject({
      status: 'current',
    });
    expect(current.asked).toEqual([]);
    // Friday's on a Saturday.
    const weekend = job({ newest: '2026-10-16', respond: () => xml(DAILY) });
    expect(await weekend.run(new Date('2026-10-17T18:07:00Z'))).toMatchObject({
      status: 'current',
    });
    expect(weekend.asked).toEqual([]);

    const off = job({
      newest: null,
      respond: () => xml(DAILY),
      fetchOn: false,
    });
    expect(await off.run(new Date())).toEqual({ status: 'off' });
    expect(off.asked).toEqual([]);
  });

  it('fetches the daily document when only the expected day is missing', async () => {
    const daily = job({
      newest: '2026-10-14',
      respond: serve({ 'eurofxref-daily.xml': DAILY }),
    });
    expect(await daily.run(new Date('2026-10-15T15:07:00Z'))).toEqual({
      status: 'fetched',
      newest: '2026-10-15',
      days: 1,
      rows: 2,
    });
    expect(daily.asked).toEqual(['eurofxref-daily.xml']);
    expect(daily.stored[0]).toEqual([
      { day: '2026-10-15', rates: { USD: '1.1652', JPY: '175.32' } },
    ]);
  });

  it('takes the 90-day history when empty or far behind, and once when the daily document skipped a day', async () => {
    const documents = serve({
      'eurofxref-daily.xml': DAILY,
      'eurofxref-hist-90d.xml': HISTORY,
    });
    const now = new Date('2026-10-15T15:07:00Z');
    // Nothing stored, or more than five working days behind: the history straight away.
    for (const newest of [null, '2026-10-07']) {
      const history = job({ newest, respond: documents });
      expect(await history.run(now)).toMatchObject({
        status: 'fetched',
        newest: '2026-10-15',
        days: 3,
      });
      expect(history.asked).toEqual(['eurofxref-hist-90d.xml']);
    }
    // Two working days behind: the daily document shows the 14th is missing, then the history.
    const gap = job({ newest: '2026-10-12', respond: documents });
    expect(await gap.run(now)).toMatchObject({ status: 'fetched', days: 3 });
    expect(gap.asked).toEqual([
      'eurofxref-daily.xml',
      'eurofxref-hist-90d.xml',
    ]);
  });

  it('asks only for the small daily document on a TARGET holiday, writes nothing, and fills in once after it (Easter Monday)', async () => {
    // Easter 2026: Good Friday 3 April and Easter Monday 6 April are TARGET holidays.
    const documents: Record<string, string> = {
      'eurofxref-daily.xml': ecbDocument({ '2026-04-02': { USD: '1.0801' } }),
      'eurofxref-hist-90d.xml': ecbDocument({
        '2026-04-07': { USD: '1.0822' },
        '2026-04-02': { USD: '1.0801' },
      }),
    };
    const easter = job({ newest: '2026-04-02', respond: serve(documents) });
    for (const hour of ['15', '16', '22']) {
      expect(await easter.run(new Date(`2026-04-06T${hour}:07:00Z`))).toEqual({
        status: 'current',
        newest: '2026-04-02',
      });
    }
    expect(easter.asked).toEqual([
      'eurofxref-daily.xml',
      'eurofxref-daily.xml',
      'eurofxref-daily.xml',
    ]);
    expect(easter.stored).toEqual([]);

    // Tuesday: the daily document has the 7th, the 6th (a holiday) looks missing: the history, once.
    easter.asked.length = 0;
    documents['eurofxref-daily.xml'] = ecbDocument({
      '2026-04-07': { USD: '1.0822' },
    });
    expect(await easter.run(new Date('2026-04-07T15:07:00Z'))).toMatchObject({
      status: 'fetched',
      newest: '2026-04-07',
    });
    expect(await easter.run(new Date('2026-04-07T16:07:00Z'))).toEqual({
      status: 'current',
      newest: '2026-04-07',
    });
    expect(easter.asked).toEqual([
      'eurofxref-daily.xml',
      'eurofxref-hist-90d.xml',
    ]);
  });

  it('keeps the stored rates when the ECB is down, answers garbage, or a document can’t be stored', async () => {
    const now = new Date('2026-10-15T15:07:00Z');
    const responses: (() => Response)[] = [
      () => new Response('', { status: 503 }),
      () => xml('<html>maintenance</html>'),
      () => {
        throw new TypeError('fetch failed');
      },
      // An impossible day (Date.parse would read it as 2 March).
      () => xml(ecbDocument({ '2026-02-30': { USD: '1.1' } })),
      // Larger than MAX_DOCUMENT_BYTES.
      () => xml(DAILY + ' '.repeat(MAX_DOCUMENT_BYTES)),
    ];
    for (const respond of responses) {
      const down = job({ newest: '2026-10-14', respond });
      const result = await down.run(now);
      expect(result).toMatchObject({ status: 'failed', newest: '2026-10-14' });
      expect(down.stored).toEqual([]);
    }
    // Parsed, then refused by the database.
    const unstorable = job({
      newest: '2026-10-14',
      respond: () => xml(DAILY),
      storeFails: new Error('invalid input syntax for type date'),
    });
    expect(await unstorable.run(now)).toMatchObject({
      status: 'failed',
      newest: '2026-10-14',
      reason: expect.stringContaining('invalid input syntax'),
    });
    expect(warn).toHaveBeenCalledTimes(responses.length + 1);
  });
});
