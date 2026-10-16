import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type Type } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  type Mailable,
  type MailableRenderOptions,
  type MailAddress,
  MailError,
  Mailer,
} from '@nestjs/mail';
import { type Job, type Queue, UnrecoverableError } from 'bullmq';

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
  constructor(
    @InjectQueue(MAIL_QUEUE) private readonly queue: Queue<QueuedMail>,
    private readonly mailer: Mailer,
  ) {}

  async send<M extends Mailable<any>>(
    mail: Type<M>,
    options: MailableRenderOptions<Parameters<M['render']>[0]>,
    /** Your own job id when the call may repeat (a retried handler): the mail goes once. */
    { jobId = randomUUID() }: { jobId?: string } = {},
  ) {
    const message = await this.mailer.render(mail, options);
    if (message.attachments.length > 0) {
      throw new Error(
        'Queued mail carries no attachments: store the file and link to it.',
      );
    }
    await this.queue.add(
      mail.name,
      {
        from: message.from,
        replyTo: [...message.replyTo],
        to: [...message.to],
        cc: [...message.cc],
        bcc: [...message.bcc],
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: { ...message.headers },
      },
      {
        jobId,
        // About six hours of retries: a provider outage doesn't lose the mail.
        attempts: 10,
        backoff: { type: 'exponential', delay: 30_000 },
      },
    );
  }
}

@Processor(MAIL_QUEUE, { concurrency: 5 })
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger('MailQueue');

  constructor(private readonly mailer: Mailer) {
    super();
  }

  async process(job: Job<QueuedMail>) {
    try {
      const sent = await this.mailer.send({
        ...job.data,
        idempotencyKey: job.id,
        // The queue retries, over hours; the mailer makes one attempt per try.
        retry: false,
      });
      return { messageId: sent.messageId };
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
}
