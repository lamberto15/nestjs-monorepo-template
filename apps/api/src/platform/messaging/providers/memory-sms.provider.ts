import {
  InboundSignatureError,
  type OutgoingSms,
  type SmsProvider,
} from './sms-provider.js';

/**
 * Keeps what it would send (tests, `SMS_PROVIDER=memory`); sends nothing and
 * cannot receive: inbound is always refused, so no unsigned request is ever
 * trusted.
 */
export class MemorySmsProvider implements SmsProvider {
  readonly name = 'memory';
  readonly sent: (OutgoingSms & { id: string })[] = [];

  async send(message: OutgoingSms) {
    const id = `mem-${this.sent.length + 1}`;
    this.sent.push({ ...message, id });
    return { id };
  }

  parseInbound(): never {
    throw new InboundSignatureError('The memory provider has no inbound.');
  }
}
