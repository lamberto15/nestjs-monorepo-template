import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SessionService, TokenService } from '@nestjs/authentication';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ConfigService } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { CoreEnv } from '../../core/config/core.env.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import type { Transaction } from '../../core/database/drizzle.js';
import { MailQueue } from '../../core/mail/mail-queue.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { CredentialsService } from '../../iam/account/credentials.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import type { PlatformEnv } from '../platform.env.js';
import { AccountDeletionMail } from './account.mails.js';
import { DeletionCancelLinks } from './deletion-cancel-links.js';
import { accountDeletions, consents } from './account.tables.js';
import { CONSENT_KIND_PATTERN, ConsentKinds } from './consent-kinds.js';

/**
 * What a person may do with their own account beyond signing in: ask for
 * its deletion (carried out after a grace period, cancellable until then),
 * record what they agreed to, and (through the data transfers) take a
 * copy of their data. Each change is one transaction with its audit entry,
 * outside any tenant: the account is the person's (docs/tenancy.md).
 */
@Injectable()
export class AccountLifecycleService {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly users: UsersRepository,
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
    private readonly mailQueue: MailQueue,
    private readonly config: ConfigService<CoreEnv & PlatformEnv, true>,
    private readonly tenancy: Tenancy,
    private readonly cancelLinks: DeletionCancelLinks,
    private readonly consentKinds: ConsentKinds,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
  ) {}

  /** The pending deletion of an account, or undefined. */
  async pendingDeletion(userId: string) {
    const [row] = await this.db
      .select()
      .from(accountDeletions)
      .where(
        and(
          eq(accountDeletions.userId, userId),
          isNull(accountDeletions.cancelledAt),
          isNull(accountDeletions.completedAt),
        ),
      );
    return row;
  }

  /**
   * Each kind the user accepted, as its latest acceptance tells it: the
   * version, when, and whether it was withdrawn since. The rows before it
   * stay, as proof (the account export holds them all).
   */
  async consents(userId: string) {
    const rows = await this.db
      .select()
      .from(consents)
      .where(eq(consents.userId, userId))
      .orderBy(desc(consents.acceptedAt), desc(consents.id));
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!latest.has(row.kind)) latest.set(row.kind, row);
    }
    return [...latest.values()].map((row) => this.consentView(row));
  }

  async state(user: UserPrincipal) {
    const deletion = await this.pendingDeletion(user.id);
    return {
      deletion: deletion ? this.deletionView(deletion) : null,
      consents: await this.consents(user.id),
    };
  }

  /**
   * Schedules the account's deletion after ACCOUNT_DELETION_GRACE_DAYS,
   * once the password (when the account has one) was checked again. The
   * route wants a recent sign-in too (`@RecentAuthentication()`); the
   * password stays because a stolen session's thief can enrol their own
   * authenticator within the window, and re-authenticating with it must not
   * be enough to lock the owner out of "sign in and cancel". A pending
   * request is returned as is. The user gets a mail saying when, with a
   * link that cancels without signing in (`cancelDeletionByLink()`).
   */
  async requestDeletion(
    user: UserPrincipal,
    password: string | undefined,
    ip?: string,
    /** The session the request came with: kept, so it can cancel. */
    sessionId?: string,
  ) {
    const pending = await this.pendingDeletion(user.id);
    if (pending) {
      return this.deletionView(pending);
    }
    const view = await this.users.findView(user.id);
    if (view?.hasPassword) {
      if (!password) {
        throw new BadRequestException({
          code: 'validation_failed',
          message: t('auth.reauthenticationIncomplete'),
          errors: [{ path: 'password', message: t('auth.required') }],
        });
      }
      // 403, not the sign-in's 401 (a web app would read that as signed out),
      // audited as what it was: a deletion refused, by this user.
      if (!(await this.credentials.matches(user.email, password))) {
        await this.tenancy.none(() =>
          this.audit.record(user, {
            action: 'account.deletion-refused',
            targetType: 'user',
            targetId: user.id,
            details: { reason: 'password' },
            ip,
          }),
        );
        throw new ForbiddenException(t('auth.wrongPassword'));
      }
    }
    const days = this.config.get('ACCOUNT_DELETION_GRACE_DAYS', {
      infer: true,
    });
    const scheduledFor = new Date(Date.now() + days * 86_400_000);
    // Only this device needs to stay signed in, to cancel (as do signing in
    // again and the mail's link): the others are signed out below.
    const others = (await this.sessions.list(user.id)).filter(
      (session) => session.id !== sessionId,
    ).length;
    const row = await this.accountLevel(async (tx) => {
      const [created] = await tx
        .insert(accountDeletions)
        .values({ userId: user.id, scheduledFor })
        .returning();
      await this.audit.record(
        user,
        {
          action: 'account.deletion-requested',
          targetType: 'user',
          targetId: user.id,
          details: {
            scheduledFor: scheduledFor.toISOString(),
            signedOut: { sessions: others, tokens: true },
          },
          ip,
        },
        tx,
      );
      return created!;
    });
    // After the commit (the package's stores, outside transactions), as a
    // password change does: every other session, and every token client
    // (their refresh tokens; an access token lives until it expires).
    await this.sessions.revokeAll(user.id, { except: sessionId });
    await this.tokens.revokeAll(user.id);
    await this.mailQueue.send(AccountDeletionMail, {
      to: { name: user.name, address: user.email },
      data: {
        name: user.name,
        scheduledFor,
        timezone: user.timezone,
        token: this.cancelLinks.sign(row),
      },
      locale: user.locale ?? undefined,
    });
    return this.deletionView(row);
  }

  /** Cancels a pending deletion; a 404 when there is none. */
  async cancelDeletion(user: UserPrincipal, ip?: string) {
    const pending = await this.pendingDeletion(user.id);
    if (!pending) {
      throw new NotFoundException('No deletion is pending for this account.');
    }
    await this.accountLevel(async (tx) => {
      const [cancelled] = await this.cancelPending(tx, pending.id, user.id);
      if (!cancelled) {
        // Carried out, started, or cancelled between the read and now.
        throw new NotFoundException('No deletion is pending for this account.');
      }
      await this.audit.record(
        user,
        {
          action: 'account.deletion-cancelled',
          targetType: 'user',
          targetId: user.id,
          ip,
        },
        tx,
      );
    });
  }

  /**
   * Cancels the deletion a mail's link names, without a sign-in: the token
   * (DeletionCancelLinks) proves the mailbox, and names one request of one
   * user. Every refusal is the same 400 (`auth.invalidLink`): a token
   * badly signed, expired, of another kind, for a request cancelled or
   * carried out already (a second use), or for an earlier request than the
   * pending one; the answer never says which, nor whether the account
   * exists. The update is conditional (still pending), so it can't race
   * the job or another cancel into both succeeding. Audited as the user's
   * `account.deletion-cancelled`, `via: link`.
   */
  async cancelDeletionByLink(token: string, ip?: string) {
    const invalid = () => new BadRequestException(t('auth.invalidLink'));
    const claims = await this.cancelLinks.verify(token);
    if (!claims) {
      throw invalid();
    }
    // Account-level, as the route has no tenant: the entry is in no
    // tenant's log (docs/tenancy.md).
    await this.accountLevel(async (tx) => {
      const [cancelled] = await this.cancelPending(
        tx,
        claims.deletionId,
        claims.userId,
      );
      const user = cancelled && (await this.users.findView(claims.userId, tx));
      if (!user) {
        throw invalid(); // rolls the update back
      }
      await this.audit.record(
        user,
        {
          action: 'account.deletion-cancelled',
          targetType: 'user',
          targetId: user.id,
          details: { via: 'link' },
          ip,
        },
        tx,
      );
    });
  }

  /**
   * Marks the request cancelled if it is still pending and the job hasn't
   * started on it, under the account's lock (the lock the job claims it
   * under, and the anonymization takes): the row, or none.
   */
  private async cancelPending(tx: Transaction, id: string, userId: string) {
    await this.users.lockAccount(tx, userId);
    return tx
      .update(accountDeletions)
      .set({ cancelledAt: new Date() })
      .where(
        and(
          eq(accountDeletions.id, id),
          eq(accountDeletions.userId, userId),
          isNull(accountDeletions.cancelledAt),
          isNull(accountDeletions.startedAt),
          isNull(accountDeletions.completedAt),
        ),
      )
      .returning({ id: accountDeletions.id });
  }

  /**
   * Records that the user accepted the current version of a declared kind
   * (`ConsentKinds`; anything else is a 400): a new row each time, so the
   * history is kept, and accepting after a withdrawal gives it again.
   */
  async accept(
    user: UserPrincipal,
    kind: string,
    version: string,
    ip?: string,
  ) {
    this.consentKinds.assertAcceptable(kind, version);
    const row = await this.accountLevel(async (tx) => {
      const [saved] = await tx
        .insert(consents)
        .values({ userId: user.id, kind, version, acceptedAt: new Date(), ip })
        .returning();
      await this.audit.record(
        user,
        {
          action: 'account.consented',
          targetType: 'user',
          targetId: user.id,
          details: { kind, version },
          ip,
        },
        tx,
      );
      return saved!;
    });
    return this.consentView(row);
  }

  /**
   * Withdraws a consent (GDPR Art. 7(3)), as easily as it was given: no
   * password, no recent sign-in. Its acceptances still in force are
   * stamped `withdrawnAt` (with the address), never deleted, in one
   * transaction with the audit entry (`account.consent-withdrawn`). A
   * required kind is refused (409 `consent_required`): the terms and the
   * privacy policy are the contract the service runs on, not a consent one
   * withdraws and stays; deleting the account ends them. A kind no longer
   * declared can still be withdrawn. Nothing in force: a 404.
   */
  async withdraw(user: UserPrincipal, kind: string, ip?: string) {
    const notGiven = () => new NotFoundException(t('auth.consentNotGiven'));
    if (!CONSENT_KIND_PATTERN.test(kind)) {
      throw notGiven();
    }
    if (this.consentKinds.get(kind)?.required) {
      throw new ConflictException({
        code: 'consent_required',
        message: t('auth.consentRequired'),
      });
    }
    const latest = await this.accountLevel(async (tx) => {
      const now = new Date();
      const withdrawn = await tx
        .update(consents)
        .set({ withdrawnAt: now, withdrawalIp: ip ?? null })
        .where(
          and(
            eq(consents.userId, user.id),
            eq(consents.kind, kind),
            isNull(consents.withdrawnAt),
          ),
        )
        .returning();
      if (withdrawn.length === 0) {
        throw notGiven();
      }
      const last = withdrawn.reduce((a, b) =>
        b.acceptedAt > a.acceptedAt ? b : a,
      );
      await this.audit.record(
        user,
        {
          action: 'account.consent-withdrawn',
          targetType: 'user',
          targetId: user.id,
          details: { kind, version: last.version },
          ip,
        },
        tx,
      );
      return last;
    });
    return this.consentView(latest);
  }

  private consentView(row: typeof consents.$inferSelect) {
    return {
      kind: row.kind,
      version: row.version,
      acceptedAt: row.acceptedAt.toISOString(),
      withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    };
  }

  /**
   * A transaction outside any tenant: the account is the person's, not a
   * tenant's (docs/tenancy.md), so its audit entries are account-level
   * (no tenant), whichever tenant the session is in.
   */
  private accountLevel<T>(work: (tx: Transaction) => Promise<T>) {
    return this.tenancy.none(() => inTransaction(this.txHost, work));
  }

  private deletionView(row: typeof accountDeletions.$inferSelect) {
    return {
      requestedAt: row.requestedAt.toISOString(),
      scheduledFor: row.scheduledFor.toISOString(),
    };
  }
}
