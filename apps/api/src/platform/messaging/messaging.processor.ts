import { Inject, Logger } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { type Job, UnrecoverableError } from 'bullmq';
import { TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { MESSAGING_JOB } from '../platform.jobs.js';
import type { PlatformEnv } from '../platform.env.js';
import { SettingsService } from '../settings/settings.service.js';
import { MessagingLimits } from './messaging-limits.service.js';
import { clip, clipBytes } from './messaging.policy.js';
import {
  MESSAGING,
  type CodeJob,
  type MessagingJob,
  type PushJob,
  type SmsJob,
} from './messaging.queue.js';
import { MessagingService } from './messaging.service.js';
import { MESSAGING_SMS_ENABLED } from './messaging.settings.js';
import {
  PUSH_PROVIDER,
  PushSendError,
  type PushProvider,
} from './providers/push-provider.js';
import {
  SMS_PROVIDER,
  SmsSendError,
  type SmsProvider,
} from './providers/sms-provider.js';

/** What a job did, for the queue's record. */
export type MessagingResult =
  | { status: 'sent' }
  | { status: 'skipped'; reason: string }
  | { status: 'blocked'; reason: string };

/**
 * Sends the SMS and push the notification channels queued, and the
 * verification codes, on the workers, in the job's tenant, as
 * `system:messaging` (docs/notifications.md, "Push and SMS").
 *
 * An SMS passes, in order: the provider is configured; the kill switch
 * (`messaging.sms`, a flag operators can force off for every tenant); the
 * number is still verified and has not opted out (checked again here: STOP
 * may have arrived since it was queued); the toll-fraud caps
 * (MessagingLimits). Then the provider sends, the text clipped to
 * SMS_MAX_LENGTH. A transient provider failure is retried by the queue; a
 * permanent one fails the job for good, and one that says the number opted
 * out records it. A push to a token the provider reports dead deletes the
 * device.
 */
@Processor(MESSAGING, { concurrency: 5 })
export class MessagingProcessor extends TenantWorkerHost<
  MessagingJob,
  MessagingResult
> {
  private readonly logger = new Logger('Messaging');

  constructor(
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider | null,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider | null,
    private readonly messaging: MessagingService,
    private readonly limits: MessagingLimits,
    private readonly settings: SettingsService,
    private readonly config: ConfigService<PlatformEnv, true>,
    private readonly system: SystemContext,
  ) {
    super();
  }

  async handle(job: Job<MessagingJob>): Promise<MessagingResult> {
    const data = job.data;
    return this.system.run(
      MESSAGING_JOB,
      () =>
        data.kind === 'push'
          ? this.sendPush(data)
          : this.sendSms(data, job.id ?? `${data.kind}-${data.userId}`),
      { transaction: false },
    );
  }

  private async sendSms(
    data: SmsJob | CodeJob,
    id: string,
  ): Promise<MessagingResult> {
    if (!this.sms) {
      throw new UnrecoverableError('SMS_PROVIDER is off.');
    }
    if (!(await this.settings.enabled(MESSAGING_SMS_ENABLED))) {
      this.logger.warn('SMS is switched off (messaging.sms): not sent', {
        job: id,
      });
      return { status: 'skipped', reason: 'switched_off' };
    }
    const phone = await this.messaging.sendablePhone(
      data.userId,
      data.kind === 'code',
    );
    if (!phone) {
      return { status: 'skipped', reason: 'no_sendable_number' };
    }
    const reserved = await this.limits.reserve(data.userId, phone);
    if (!reserved.ok) {
      return { status: 'blocked', reason: reserved.reason };
    }
    const text =
      data.kind === 'code'
        ? `Your verification code is ${await this.messaging.issueCode(data.userId)}. It expires in 10 minutes.`
        : data.text;
    try {
      await this.sms.send({
        to: phone,
        body: clip(text, this.config.get('SMS_MAX_LENGTH', { infer: true })),
        idempotencyKey: id,
      });
    } catch (error) {
      if (error instanceof SmsSendError) {
        if (error.optedOut) {
          await this.messaging.optOut(phone, 'provider');
        }
        if (error.permanent) {
          throw new UnrecoverableError(error.message);
        }
      }
      throw error;
    }
    return { status: 'sent' };
  }

  private async sendPush(data: PushJob): Promise<MessagingResult> {
    if (!this.push) {
      throw new UnrecoverableError('PUSH_PROVIDER is off.');
    }
    const device = await this.messaging.deviceToken(data.deviceId);
    if (!device || !this.push.platforms.includes(device.platform)) {
      return { status: 'skipped', reason: 'no_device' };
    }
    const max = this.config.get('PUSH_MAX_PAYLOAD_BYTES', { infer: true });
    // The body is what gives; the envelope (id, link) is small and fixed.
    const payload = {
      id: data.notificationId,
      title: clip(data.title, 120),
      body: data.body,
      link: data.link ?? undefined,
    };
    // Shrink the body until the whole JSON fits (escaping can make it longer than its bytes).
    let budget =
      max - Buffer.byteLength(JSON.stringify({ ...payload, body: '' }));
    payload.body = clipBytes(data.body, Math.max(0, budget));
    while (Buffer.byteLength(JSON.stringify(payload)) > max && budget > 0) {
      budget -= Buffer.byteLength(JSON.stringify(payload)) - max;
      payload.body = clipBytes(data.body, Math.max(0, budget));
    }
    try {
      const result = await this.push.send(device.token, payload);
      if (result === 'gone') {
        await this.messaging.dropDevice(data.deviceId);
        return { status: 'skipped', reason: 'device_gone' };
      }
    } catch (error) {
      if (error instanceof PushSendError && error.permanent) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
    return { status: 'sent' };
  }
}
