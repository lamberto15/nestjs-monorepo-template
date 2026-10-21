import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { StorageDisk, type StoredUpload } from '@nestjs/storage';
import { and, eq } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { avatarUrl } from '../../iam/account/avatar-url.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { memberships, users } from '../../iam/iam.tables.js';

/** How long a link to a picture works: it is followed at once (the redirect of GET /v1/people/{id}/avatar). */
const AVATAR_LINK_TTL = '5m';

/**
 * The picture of a user's account (`PUT`, `DELETE /v1/account/avatar`). The
 * file is on the private disk under the account (`accounts/<id>/avatar/…`),
 * its key in `users.avatar_key`; the row change and its audit entry
 * (`account.avatar-changed`, `account.avatar-removed`) commit together, and
 * the file it replaces goes after the commit. Seen by the members of a
 * tenant the person belongs to (`GET /v1/people/{id}/avatar`), through the
 * `avatarUrl` the people lookup and the signed-in user carry.
 *
 * Stored as uploaded (type and size checked): there is no image library in
 * the template yet to resize it or strip its metadata (EXIF), see
 * docs/attachments.md "Avatars".
 */
@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly disk: StorageDisk,
    private readonly tenancy: Tenancy,
  ) {}

  /** Records the stored file (`file.key`) as the user's picture. Failed, the file is deleted. */
  async set(user: UserPrincipal, file: StoredUpload, ip?: string) {
    try {
      const previous = await this.change(user, file.key, ip, {
        size: file.size,
        contentType: file.contentType,
      });
      await this.dispose(previous);
      return { avatarUrl: avatarUrl(user.id, file.key) };
    } catch (error) {
      await this.dispose(file.key);
      throw error;
    }
  }

  /** Removes the picture, file and key; nothing to do without one. */
  async remove(user: UserPrincipal, ip?: string) {
    await this.dispose(await this.change(user, null, ip));
  }

  /**
   * A signed link to the user's picture, for a member of a tenant the
   * viewer acts in (or the user themselves): 404 for anyone else or when
   * there is no picture, so it never tells those apart.
   */
  async link(viewer: UserPrincipal, userId: string) {
    const tenantId = requireTenantId('A picture');
    const [row] =
      viewer.id === userId
        ? await this.db
            .select({ key: users.avatarKey })
            .from(users)
            .where(eq(users.id, userId))
        : await this.db
            .select({ key: users.avatarKey })
            .from(users)
            .innerJoin(
              memberships,
              and(
                eq(memberships.userId, users.id),
                eq(memberships.tenantId, tenantId),
              ),
            )
            .where(eq(users.id, userId));
    if (!row?.key) {
      throw new NotFoundException('No picture.');
    }
    return {
      url: await this.disk.signedUrl(row.key, { expiresIn: AVATAR_LINK_TTL }),
    };
  }

  /** The key change and its audit entry in one account-level transaction; the key it replaced. */
  private async change(
    user: UserPrincipal,
    key: string | null,
    ip: string | undefined,
    details?: Record<string, unknown>,
  ) {
    return this.tenancy.none(() =>
      inTransaction(this.txHost, async (tx) => {
        const changed = await this.users.setAvatarKey(tx, user.id, key);
        if (!changed) {
          throw new UnauthorizedException();
        }
        if (key !== null || changed.previous !== null) {
          await this.audit.record(
            user,
            {
              action: key ? 'account.avatar-changed' : 'account.avatar-removed',
              targetType: 'user',
              targetId: user.id,
              details,
              ip,
            },
            tx,
          );
        }
        return changed.previous;
      }),
    );
  }

  /** Deletes a replaced or abandoned file; a failure leaves an orphan, never a failed request. */
  private async dispose(key: string | null) {
    if (!key) return;
    await this.disk.delete(key).catch((error: unknown) =>
      this.logger.warn('An avatar file was not deleted', {
        key,
        error: String(error),
      }),
    );
  }
}
