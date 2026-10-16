import type { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpClient, InjectHttpClient } from '@nestjs/http-client';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { SystemContext } from '../../iam/access/system-context.js';
import type { PlatformEnv } from '../platform.env.js';
import { EXCHANGE_RATES_JOB } from '../platform.jobs.js';
import { EcbFormatError, parseEcbRates } from './ecb-rates.js';
import { ECB, ExchangeRatesService } from './exchange-rates.service.js';

/** The @nestjs/http-client client of the ECB's reference rates (MoneyModule registers it). */
export const ECB_RATES = 'ecb-rates';

/**
 * The hour (UTC) by which a working day's ECB rates are out: the ECB
 * publishes them around 16:00 CET (14:00 UTC in summer, 15:00 in winter).
 */
export const ECB_PUBLISHED_BY_UTC_HOUR = 15;

const iso = (date: Date) => date.toISOString().slice(0, 10);

/** The working day (Monday to Friday) before `day`. */
export function previousWorkingDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  do {
    date.setUTCDate(date.getUTCDate() - 1);
  } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return iso(date);
}

/**
 * The newest day whose ECB rates should be out at `now`: today from 15:00
 * UTC on a weekday, else the working day before. TARGET holidays aren't
 * known here: on one, the job asks again each hour and gets the day before.
 */
export function expectedDay(now: Date): string {
  const today = iso(now);
  const date = new Date(`${today}T00:00:00Z`);
  const weekday = date.getUTCDay() !== 0 && date.getUTCDay() !== 6;
  return weekday && now.getUTCHours() >= ECB_PUBLISHED_BY_UTC_HOUR
    ? today
    : previousWorkingDay(today);
}

/** The working day `n` working days before `day`. */
export function workingDaysBefore(day: string, n: number): string {
  let result = day;
  for (let i = 0; i < n; i++) {
    result = previousWorkingDay(result);
  }
  return result;
}

const DAILY = 'eurofxref-daily.xml';
const HISTORY = 'eurofxref-hist-90d.xml';

/** Further behind than this many working days, the job reads the 90-day history straight away. */
export const HISTORY_AFTER_WORKING_DAYS = 5;

/**
 * The largest document read: the 90-day history is about 50 kB, the daily
 * one 2 kB. @nestjs/http-client has no response size limit, so the body is
 * read as a stream and given up past this.
 */
export const MAX_DOCUMENT_BYTES = 1_000_000;

/** How long reading one document may take, body included (the client's own timeout stops at the headers for a stream). */
const DOCUMENT_TIMEOUT_MS = 60_000;

/** `body` as text, or an error once it passes `max` bytes. */
export async function readCapped(body: Readable, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > max) {
      body.destroy();
      throw new EcbFormatError(`the document is larger than ${max} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type ExchangeRatesRun =
  | { status: 'off' }
  /** Nothing new: the stored newest day is the one expected, or the ECB has published nothing later (a TARGET holiday). */
  | { status: 'current'; newest: string }
  /** `rows`: the rows written (new days, and corrected rates); unchanged ones aren't. */
  | { status: 'fetched'; newest: string; days: number; rows: number }
  | { status: 'failed'; newest: string | null; reason: string };

/**
 * Fetches the ECB's euro reference rates and stores them, every hour at :07
 * on one instance (a worker: cron jobs run where SCHEDULER and the role
 * allow), as the system principal `system:exchange-rates`.
 *
 * - Nothing to do while the newest stored day is the one expected
 *   (`expectedDay()`): one fetch per working day, after 15:00 UTC.
 * - The daily document normally. The 90-day history when nothing is stored
 *   or the newest stored day is more than five working days behind; and
 *   once after the daily document skipped a working day the table lacks
 *   (an outage of a few days, or the day after a TARGET holiday, when the
 *   history fills nothing and costs one request), so missed days are filled in.
 * - The ECB publishing nothing newer (a TARGET holiday): `current`, nothing
 *   written; the job asks again the next hour.
 * - The ECB unreachable, answering garbage or a document that can't be
 *   stored: a warning, the stored rates stay, the next hour tries again.
 *   `exchange_rates_age_seconds` on /metrics grows, and ExchangeRatesStale
 *   fires past six days (monitoring/prometheus/alerts.yml).
 *
 * The fetch runs outside any transaction; the store is one transaction.
 */
@Injectable()
export class ExchangeRatesJob {
  private readonly logger = new Logger('ExchangeRates');

  constructor(
    @InjectHttpClient(ECB_RATES) private readonly http: HttpClient,
    private readonly rates: ExchangeRatesService,
    private readonly config: ConfigService<PlatformEnv, true>,
    private readonly system: SystemContext,
  ) {}

  @Cron('7 * * * *', { name: 'exchange-rates', timeZone: 'UTC' })
  @OnOneInstance({ key: 'money:exchange-rates' })
  @WithoutOverlapping()
  run(now = new Date()): Promise<ExchangeRatesRun> {
    return this.refresh(now);
  }

  /**
   * One run at `now`, without the schedule's lock (the unit tests build
   * the job with `new`, which the locks don't know).
   */
  refresh(now = new Date()): Promise<ExchangeRatesRun> {
    if (!this.config.get('EXCHANGE_RATES_FETCH', { infer: true })) {
      return Promise.resolve({ status: 'off' });
    }
    return this.system.run(
      EXCHANGE_RATES_JOB,
      async (): Promise<ExchangeRatesRun> => {
        const expected = expectedDay(now);
        const newest = await this.rates.newestDay(ECB.source);
        if (newest && newest >= expected) {
          return { status: 'current', newest };
        }
        try {
          let document =
            !newest ||
            newest < workingDaysBefore(expected, HISTORY_AFTER_WORKING_DAYS)
              ? HISTORY
              : DAILY;
          let days = await this.fetch(document);
          let latest = newestOf(days);
          if (
            document === DAILY &&
            newest &&
            latest > newest &&
            previousWorkingDay(latest) > newest
          ) {
            // A working day between the stored newest and this one is missing.
            document = HISTORY;
            days = await this.fetch(document);
            latest = newestOf(days);
          }
          if (newest && latest <= newest) {
            this.logger.debug(
              `No ECB rates after ${newest} yet (expected ${expected}): nothing stored`,
            );
            return { status: 'current', newest };
          }
          const rows = await this.rates.store(days, ECB);
          this.logger.log('ECB rates stored', {
            document,
            days: days.length,
            rows,
            newest: latest,
          });
          return { status: 'fetched', newest: latest, days: days.length, rows };
        } catch (error) {
          const reason = describe(error);
          this.logger.warn(
            `ECB rates not fetched or stored (${reason}): the rates of ${newest ?? 'no day'} stay`,
          );
          return { status: 'failed', newest, reason };
        }
      },
      { transaction: false },
    );
  }

  /** One eurofxref document, read (at most MAX_DOCUMENT_BYTES) and parsed. */
  private async fetch(document: string) {
    const response = await this.http.get(`/${document}`, {
      responseType: 'stream',
      signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
    });
    return parseEcbRates(
      await readCapped(response.data as Readable, MAX_DOCUMENT_BYTES),
    );
  }
}

/** The newest day of a parsed document (never empty: the parser refuses one). */
const newestOf = (days: readonly { day: string }[]) =>
  days
    .map((each) => each.day)
    .sort()
    .at(-1)!;

/** An error's kind and status, for the log. */
function describe(error: unknown) {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number'
    ? `${error.name} ${status}`
    : `${error.name}: ${error.message}`;
}
