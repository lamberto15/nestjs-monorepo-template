import { BadRequestException, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { t } from '@nestjs/i18n';
import { sql } from 'drizzle-orm';
import {
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { principalKey } from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { NotificationCatalog } from './notification-catalog.js';
import { NotificationUnsubscribeLinks } from './notification-unsubscribe.js';
import type { PreferenceOverrides } from './notification.types.js';
import { notificationPreferences } from './notifications.tables.js';
import { NotificationsService } from './notifications.service.js';

/**
 * The one-click unsubscribe of notification mail (RFC 8058): the token of a
 * mail's `List-Unsubscribe` link (NotificationUnsubscribeLinks) names a user
 * and a type, or the modes of a digest, and this switches the mail for them
 * off, in the user's preferences, without a sign-in. A mandatory type is
 * never switched off, whatever the token says. Doing it again changes
 * nothing. Every refusal is the same 400 (`auth.invalidLink`): a token
 * forged, expired or of another kind, or an account gone or deactivated.
 * Account-level, as the route has no tenant: preferences are the person's
 * and the audit entry is in no tenant's log (docs/tenancy.md).
 */
@Injectable()
export class NotificationUnsubscribeService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly links: NotificationUnsubscribeLinks,
    private readonly catalog: NotificationCatalog,
    private readonly notifications: NotificationsService,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly tenancy: Tenancy,
  ) {}

  async unsubscribe(token: string, ip?: string) {
    const claims = await this.links.verify(token);
    const user = claims && (await this.users.findActive(claims.userId));
    if (!claims || !user) {
      throw new BadRequestException(t('auth.invalidLink'));
    }
    const recipient = principalKey(user);
    await this.tenancy.none(() =>
      inTransaction(this.txHost, async (tx) => {
        // One change at a time per person: two links pressed together keep both.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`notification-preferences:${recipient}`}))`,
        );
        const from = await this.notifications.overrides(recipient);
        const to: PreferenceOverrides = { ...from };
        const switched: string[] = [];
        for (const declaration of this.catalog.declarations()) {
          if (declaration.mandatory) continue;
          const mode = this.catalog.effective(
            declaration,
            from[declaration.type],
            user,
          ).email;
          const named =
            claims.type !== undefined
              ? declaration.type === claims.type
              : (claims.digests ?? []).includes(mode as 'hourly' | 'daily');
          if (!named || !mode) continue;
          to[declaration.type] = { ...from[declaration.type], email: false };
          switched.push(declaration.type);
        }
        if (switched.length === 0) return; // off already, or not a type any more
        await tx
          .insert(notificationPreferences)
          .values({ recipient, settings: to })
          .onConflictDoUpdate({
            target: notificationPreferences.recipient,
            set: { settings: to },
          });
        await this.audit.record(
          user,
          {
            action: 'notificationPreferences.updated',
            targetType: 'notificationPreferences',
            targetId: recipient,
            details: { from, to, via: 'unsubscribe', types: switched },
            ip,
          },
          tx,
        );
      }),
    );
  }
}
