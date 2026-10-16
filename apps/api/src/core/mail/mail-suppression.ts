import type { Type } from '@nestjs/common';

/**
 * Why a recipient is not written to (docs/deliverability.md):
 * `hard_bounce` (the mailbox doesn't exist), `soft_bounce` (it refused
 * MAIL_SOFT_BOUNCE_THRESHOLD deliveries in a row), `complaint` (the
 * person reported a mail as spam), `manual` (an administrator added it).
 */
export const SUPPRESSION_REASONS = [
  'hard_bounce',
  'soft_bounce',
  'complaint',
  'manual',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** What the sender learns about one recipient. */
export type SuppressionVerdict =
  { send: true } | { send: false; reason: SuppressionReason };

/**
 * The suppression list, as the mail queue asks it (core can't import the
 * platform, which keeps the list: the platform provides this token,
 * `MailQueue`'s processor injects it optionally and sends to everyone
 * when nothing provides it).
 */
export interface MailSuppression {
  /**
   * The verdict for each address. `essential` is the mail's marker
   * (`@EssentialMail()`): one the person asked for or must be told
   * (a password reset, a deletion notice), which still goes to an
   * address that complained; never to one that bounced or was listed by
   * hand. `skipped` recipients are counted on their entry.
   */
  check(
    addresses: readonly string[],
    options: { essential: boolean; mail: string },
  ): Promise<Map<string, SuppressionVerdict>>;
}

export const MAIL_SUPPRESSION = Symbol('MAIL_SUPPRESSION');

const ESSENTIAL = Symbol('essential-mail');

/**
 * Marks a mail class as essential: requested by the recipient (a password
 * reset, a sign-in link, an address confirmation) or a notice they must
 * get (their account's deletion). The suppression list lets it through to
 * an address that complained, since the person asked for this one; a
 * mailbox that doesn't exist (a hard bounce) or an administrator's entry
 * still stops it. Everything else (notifications, digests, reports) is
 * not essential.
 */
export const EssentialMail = (): ClassDecorator => (target) => {
  Reflect.defineMetadata(ESSENTIAL, true, target);
};

/** Whether a mail class carries `@EssentialMail()`. */
export const isEssentialMail = (mail: Type<unknown>) =>
  Reflect.getMetadata(ESSENTIAL, mail) === true;

/**
 * An address as the suppression list keys it: trimmed, lower case (the
 * local part is case-insensitive in practice, and providers report what
 * they sent to). `@nestjs/mail` has already put the domain in ASCII.
 */
export const normalizeAddress = (address: string) =>
  address.trim().toLowerCase();
