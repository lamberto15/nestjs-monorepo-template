import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, desc, eq, exists, isNull } from 'drizzle-orm';
import {
  headline,
  matches,
  rank,
  rankedMatches,
} from '../../core/database/search.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  type SearchHit,
  SearchRegistry,
  type SearchSource,
} from '../search/search.registry.js';
import { AttachmentTextQueue } from './attachment-text.queue.js';
import { attachmentTexts } from './attachment-text.tables.js';
import {
  type AttachmentTarget,
  AttachmentsRegistry,
} from './attachments.registry.js';
import { attachments } from './attachments.tables.js';

/**
 * Files in the global search (ATTACHMENT_TEXT_SEARCH): the attachments whose
 * extracted text matches, of the records the principal may read now (each
 * target's read filter, `AccessService.sqlFilter()`, with its recycle bin
 * left out), best match first, a snippet of the text, a link to the record.
 * Only the text of the file the attachment has now (a replaced file's never
 * matches), only clean files, and never a generated one.
 */
@Injectable()
export class AttachmentSearch implements SearchSource {
  readonly subject = 'Attachment';

  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly access: AccessService,
    private readonly targets: AttachmentsRegistry,
    private readonly queue: AttachmentTextQueue,
    registry: SearchRegistry,
  ) {
    registry.register(this);
  }

  async search(
    principal: Principal,
    q: string,
    limit: number,
  ): Promise<SearchHit[]> {
    if (!this.queue.enabled) {
      return [];
    }
    const hits = await Promise.all(
      this.targets.all().map((target) => this.of(target, principal, q, limit)),
    );
    return hits
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** The matching files of one kind of record. */
  private async of(
    target: AttachmentTarget,
    principal: Principal,
    q: string,
    limit: number,
  ): Promise<SearchHit[]> {
    const records = target.records;
    // On attachment_texts alone, so that the capped count and the ranking
    // find the matches by the GIN index (`@@` is leakproof under RLS:
    // #858), and the record's read filter decides per match.
    const where = and(
      matches(attachmentTexts.search, q),
      exists(
        this.db
          .select({ id: attachments.id })
          .from(attachments)
          .innerJoin(records.table, eq(records.id, attachments.recordId))
          .where(
            and(
              eq(attachments.id, attachmentTexts.attachmentId),
              eq(attachments.key, attachmentTexts.key),
              eq(attachments.subject, target.subject),
              eq(attachments.scanStatus, 'clean'),
              isNull(attachments.fields),
              await this.access.sqlFilter(principal, target.subject, 'read'),
            ),
          ),
      ),
    );
    const score = rank(attachmentTexts.search, q);
    const rows = await this.db
      .select({
        id: attachments.id,
        name: attachments.name,
        recordId: attachments.recordId,
        score,
        snippet: headline(attachmentTexts.text, q),
      })
      .from(attachmentTexts)
      .innerJoin(attachments, eq(attachments.id, attachmentTexts.attachmentId))
      // The best of the newest RANK_CAP matches: ranking reads every row it ranks (#861).
      .where(
        and(
          where,
          await rankedMatches(
            this.db,
            attachmentTexts,
            attachmentTexts.id,
            where,
          ),
        ),
      )
      .orderBy(desc(score), desc(attachmentTexts.id))
      .limit(limit);
    return rows.map((row) => ({
      subject: this.subject,
      id: row.id,
      title: row.name,
      snippet: row.snippet.includes('<b>') ? row.snippet : null,
      score: Number(row.score),
      link: target.link?.(row.recordId) ?? null,
    }));
  }
}
