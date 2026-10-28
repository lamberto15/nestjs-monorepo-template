import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, count, eq, inArray, max } from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { uniqueToConflict } from '../../iam/access/api-clients.service.js';
import {
  principalKey,
  type RequestPrincipal,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { RecordPurgeRegistry } from '../../iam/resources/record-purge.registry.js';
import {
  type PersonalDataSource,
  PersonalDataRegistry,
} from '../account/personal-data.registry.js';
import { SubscriptionsRegistry } from '../subscriptions/subscriptions.registry.js';
import { ViewsService } from '../views/views.service.js';
import {
  type CreateFavoriteDto,
  MAX_FAVORITES,
  type ReorderFavoritesDto,
} from './favorite.schemas.js';
import { favorites } from './favorites.tables.js';

type Row = typeof favorites.$inferSelect;

/**
 * A person's favorites: records, pages and saved views they pin, in their
 * order. Pinning a record or a view checks they see it (as watching does:
 * the subject's SubscriptionTarget; the views' own visibility), and the
 * list leaves out what they no longer see or what is gone, so a label is
 * never shown for a record they may not read. Their own alone (no audit,
 * like what they watch); in their data export, and gone with their account.
 */
@Injectable()
export class FavoritesService implements PersonalDataSource {
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly targets: SubscriptionsRegistry,
    private readonly views: ViewsService,
    personalData: PersonalDataRegistry,
    purges: RecordPurgeRegistry,
  ) {
    personalData.register(this);
    // A record purged from its recycle bin is nobody's favorite any more.
    purges.register({
      name: 'favorites',
      forget: (tx, subject, ids) => this.forgetAll(tx, subject, ids),
    });
  }

  /** As a personal data source: the person's favorites are in their export… */
  readonly name = 'favorite';
  async *rows(user: UserPrincipal) {
    const rows = await this.db
      .select()
      .from(favorites)
      .where(eq(favorites.owner, principalKey(user)))
      .orderBy(asc(favorites.position));
    if (rows.length) yield rows.map((row) => this.item(row));
  }

  /** …and go with their account. */
  async erase(tx: Transaction, user: UserPrincipal) {
    await tx.delete(favorites).where(eq(favorites.owner, principalKey(user)));
  }

  /** The principal's favorites in their order, without what they no longer see. */
  async list(principal: RequestPrincipal) {
    const rows = await this.db
      .select()
      .from(favorites)
      .where(eq(favorites.owner, principalKey(principal)))
      .orderBy(asc(favorites.position), asc(favorites.id));
    const seen = await Promise.all(
      rows.map((row) => this.sees(principal, row)),
    );
    return {
      items: rows.filter((_, i) => seen[i]).map((row) => this.item(row)),
    };
  }

  /** Pins something the principal sees, last in their list. */
  async add(principal: RequestPrincipal, dto: CreateFavoriteDto) {
    await this.assertSees(principal, dto);
    const owner = principalKey(principal);
    try {
      return await inTransaction(this.txHost, async (tx) => {
        const [{ total, last }] = await tx
          .select({ total: count(), last: max(favorites.position) })
          .from(favorites)
          .where(eq(favorites.owner, owner));
        if (total >= MAX_FAVORITES) {
          throw new BadRequestException(
            `At most ${MAX_FAVORITES} favorites: remove one first.`,
          );
        }
        const [row] = await tx
          .insert(favorites)
          .values({ ...dto, owner, position: (last ?? -1) + 1 })
          .returning();
        return this.item(row!);
      });
    } catch (error) {
      throw uniqueToConflict(error, 'It is a favorite already.');
    }
  }

  /** Unpins one of the principal's favorites, or a 404. */
  async remove(principal: RequestPrincipal, id: string) {
    const deleted = await inTransaction(this.txHost, (tx) =>
      tx
        .delete(favorites)
        .where(
          and(
            eq(favorites.id, id),
            eq(favorites.owner, principalKey(principal)),
          ),
        )
        .returning({ id: favorites.id }),
    );
    if (deleted.length === 0) {
      throw new NotFoundException(`Favorite ${id} not found.`);
    }
  }

  /** Puts the principal's favorites in the given order: every one of them, once. */
  async reorder(principal: RequestPrincipal, dto: ReorderFavoritesDto) {
    const owner = principalKey(principal);
    await inTransaction(this.txHost, async (tx) => {
      const rows = await tx
        .select({ id: favorites.id })
        .from(favorites)
        .where(eq(favorites.owner, owner));
      const mine = new Set(rows.map((row) => row.id));
      if (
        dto.ids.length !== mine.size ||
        new Set(dto.ids).size !== dto.ids.length ||
        !dto.ids.every((id) => mine.has(id))
      ) {
        throw new BadRequestException(
          'List every one of your favorites, once each.',
        );
      }
      for (const [position, id] of dto.ids.entries()) {
        await tx
          .update(favorites)
          .set({ position })
          .where(and(eq(favorites.id, id), eq(favorites.owner, owner)));
      }
    });
    return this.list(principal);
  }

  /** When records are gone for good: nobody's favorites any more. */
  async forgetAll(tx: Transaction, subject: string, recordIds: string[]) {
    await tx
      .delete(favorites)
      .where(
        and(
          eq(favorites.kind, 'record'),
          eq(favorites.subject, subject),
          inArray(favorites.target, recordIds),
        ),
      );
  }

  /** Whether the principal sees what a favorite points at (a page always: the menu gates pages). */
  private async sees(
    principal: RequestPrincipal,
    favorite: Pick<Row, 'kind' | 'subject' | 'target'>,
  ) {
    try {
      await this.assertSees(principal, favorite);
      return true;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        return false;
      }
      throw error;
    }
  }

  /** A 404 unless the principal sees the record or view (as reading it would). */
  private async assertSees(
    principal: RequestPrincipal,
    favorite: Pick<Row, 'kind' | 'subject' | 'target'>,
  ) {
    if (favorite.kind === 'record') {
      const target = this.targets.find(favorite.subject);
      if (!target) {
        throw new NotFoundException(`No records of ${favorite.subject}.`);
      }
      await target.assertCanWatch(principal, favorite.target);
    } else if (favorite.kind === 'view') {
      await this.views.get(principal, favorite.target);
    }
  }

  private item(row: Row) {
    return {
      id: row.id,
      kind: row.kind,
      subject: row.subject,
      target: row.target,
      label: row.label,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
