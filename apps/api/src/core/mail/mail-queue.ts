import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type Type,
} from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  type Mailable,
  type MailableRenderOptions,
  type MailAddress,
  MailError,
  Mailer,
} from '@nestjs/mail';
import { type Job, type Queue, UnrecoverableError } from 'bullmq';
import { Counter } from 'prom-client';
import { abortable } from '../queues/abortable.js';
import { MetricsService } from '../metrics/metrics.service.js';
import {
  DEFAULT_MAIL_BRAND,
  MAIL_BRANDING,
  type MailBranding,
  withMailBrand,
} from './mail-branding.js';
import {
  isEssentialMail,
  MAIL_SUPPRESSION,
  type MailSuppression,
  normalizeAddress,
  SUPPRESSION_REASONS,
  type SuppressionReason,
} from './mail-suppression.js';

/** The queue every mail goes through. */
export const MAIL_QUEUE = 'mail';

/** A rendered mail, ready to send: what a job carries. */
interface QueuedMail {
  from: MailAddress;
  replyTo: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  html?: string;
  text?: string;
  headers: Record<string, string>;
  /** The mail class carries `@EssentialMail()`: it still goes to an address that complained. */
  essential?: boolean;
}

/** What a mail job ends as: sent, or skipped for every recipient. */
export interface MailJobResult {
  messageId?: string;
  /** Recipients the suppression list kept the mail from, with why. */
  skipped: { address: string; reason: SuppressionReason }[];
}

/**
 * Sends mail through a queue: the request renders it (template, language,
 * time zone) and returns at once; a worker sends it, retrying a provider
 * that is down for hours with backoff. The job id is the mail's idempotency
 * key, so a retry after a crash doesn't send it twice (SMTP Message-ID,
 * Resend). A refusal that won't change (an unknown address) fails at once.
 *
 * ```ts
 * await this.mailQueue.send(WelcomeMail, { to: user.email, data: user, locale: user.locale });
 * ```
 */
@Injectable()
export class MailQueue {
  private readonly logger = new Logger('MailQueue');

  constructor(
    @InjectQueue(MAIL_QUEUE) private readonly queue: Queue<QueuedMail>,
    private readonly mailer: Mailer,
    @Optional()
    @Inject(MAIL_BRANDING)
    private readonly branding?: MailBranding,
  ) {}

  async send<M extends Mailable<any>>(
    mail: Type<M>,
    options: MailableRenderOptions<Parameters<M['render']>[0]>,
    {
      jobId = randomUUID(),
      signal,
    }: {
      /** Your own job id when the call may repeat (a retried handler): the mail goes once. */
      jobId?: string;
      /** Stops waiting for Redis (the add may still land: the job id makes that harmless). */
      signal?: AbortSignal;
    } = {},
  ) {
    signal?.throwIfAborted();
    // The tenant's logo and colour in the templates, its name on the sender
    // (unless the mail class sets its own `from`: options.from).
    // Cosmetic: a failed lookup (the settings, the object store) never keeps
    // a mail back, a sign-in link's or a reset's included.
    const brand = await this.brand();
    const message = await withMailBrand(brand, () =>
      this.mailer.render(mail, options),
    );
    if (message.attachments.length > 0) {
      throw new Error(
        'Queued mail carries no attachments: store the file and link to it.',
      );
    }
    await abortable(
      signal,
      this.queue.add(
        mail.name,
        {
          from:
            brand.name && !options.from
              ? { ...message.from, name: brand.name }
              : message.from,
          replyTo: [...message.replyTo],
          to: [...message.to],
          cc: [...message.cc],
          bcc: [...message.bcc],
          subject: message.subject,
          html: message.html,
          text: message.text,
          headers: { ...message.headers },
          essential: isEssentialMail(mail),
        },
        {
          jobId,
          // About six hours of retries: a provider outage doesn't lose the mail.
          attempts: 10,
          backoff: { type: 'exponential', delay: 30_000 },
        },
      ),
    );
  }

  /** The tenant's brand, or the default when there is none or it can't be read (logged). */
  private async brand() {
    try {
      return (await this.branding?.current()) ?? DEFAULT_MAIL_BRAND;
    } catch (error) {
      this.logger.warn('Mail sent unbranded: the brand could not be read', {
        error: error instanceof Error ? error.message : String(error),
      });
      return DEFAULT_MAIL_BRAND;
    }
  }
}

/**
 * The worker's side: asks the suppression list about every recipient right
 * before sending (the list is read then, not when the mail was queued,
 * since a job may wait hours), drops the ones it names, and sends to the
 * rest. A mail with no recipient left is done, not failed: its result
 * says who was skipped and why, and `mail_suppressed_total` counts them.
 */
@Processor(MAIL_QUEUE, { concurrency: 5 })
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger('MailQueue');
  private readonly sent: Counter;
  private readonly suppressed: Counter<'reason'>;

  constructor(
    private readonly mailer: Mailer,
    metrics: MetricsService,
    @Optional()
    @Inject(MAIL_SUPPRESSION)
    private readonly suppression?: MailSuppression,
  ) {
    super();
    this.sent = new Counter({
      name: 'mail_sent_total',
      help: 'Mails the transport accepted (the mail queue, on the workers).',
      registers: [metrics.registry],
    });
    this.sent.inc(0);
    this.suppressed = new Counter({
      name: 'mail_suppressed_total',
      help: 'Recipients a mail was not sent to because the suppression list names them, by reason.',
      labelNames: ['reason'] as const,
      registers: [metrics.registry],
    });
    for (const reason of SUPPRESSION_REASONS) {
      this.suppressed.labels(reason).inc(0);
    }
  }

  async process(job: Job<QueuedMail>): Promise<MailJobResult> {
    const { recipients, skipped } = await this.allowed(job);
    if (
      recipients.to.length + recipients.cc.length + recipients.bcc.length ===
      0
    ) {
      this.logger.warn('Mail not sent: every recipient is suppressed', {
        jobId: job.id,
        mail: job.name,
        skipped,
      });
      return { skipped };
    }
    try {
      const sent = await this.mailer.send({
        ...job.data,
        ...recipients,
        idempotencyKey: job.id,
        // The queue retries, over hours; the mailer makes one attempt per try.
        retry: false,
      });
      this.sent.inc();
      return { messageId: sent.messageId, skipped };
    } catch (error) {
      if (error instanceof MailError && error.permanent) {
        this.logger.warn(`Mail refused for good: ${error.message}`, {
          jobId: job.id,
        });
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  /** The recipients the list lets through, and the ones it kept (counted). */
  private async allowed(job: Job<QueuedMail>) {
    const { to, cc, bcc, essential = false } = job.data;
    const skipped: MailJobResult['skipped'] = [];
    if (!this.suppression) {
      return { recipients: { to, cc, bcc }, skipped };
    }
    const all = [...to, ...cc, ...bcc].map((r) => normalizeAddress(r.address));
    const verdicts = await this.suppression.check(all, {
      essential,
      mail: job.name,
    });
    const keep = (list: MailAddress[]) =>
      list.filter((recipient) => {
        const verdict = verdicts.get(normalizeAddress(recipient.address));
        if (!verdict || verdict.send) {
          return true;
        }
        skipped.push({ address: recipient.address, reason: verdict.reason });
        this.suppressed.labels(verdict.reason).inc();
        return false;
      });
    const recipients = { to: keep(to), cc: keep(cc), bcc: keep(bcc) };
    if (skipped.length > 0) {
      this.logger.log('Suppressed recipients left out of a mail', {
        jobId: job.id,
        mail: job.name,
        skipped,
      });
    }
    return { recipients, skipped };
  }
}
