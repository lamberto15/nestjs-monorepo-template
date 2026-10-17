import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { StorageDisk } from '@nestjs/storage';
import { and, eq, sql } from 'drizzle-orm';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { AttachmentsService } from '../../platform/attachments/attachments.service.js';
import { CommentsService } from '../../platform/comments/comments.service.js';
import { tenantFileKey } from '../../platform/storage/storage.config.js';
import { TagsService } from '../../platform/tags/tags.service.js';
import { tags as tagsTable } from '../../platform/tags/tags.tables.js';
import type { FeatureDemoContext, FeatureDemoSeeder } from '../feature.js';
import { DEMO_NOTES, DEMO_TAGS } from './notes.demo-data.js';
import { NotesService } from './notes.service.js';

/**
 * Notes' demo data (`pnpm db:seed:demo`, NOTES_FEATURE.demo): tags, and
 * notes owned by the demo users (their `mine` and `inMyTeams` conditions
 * then show something), tagged, two with a comment that mentions a
 * colleague, one with a file. Written through the services, as the seed.
 */
@Injectable()
export class NotesDemo implements FeatureDemoSeeder {
  constructor(
    private readonly notes: NotesService,
    private readonly users: UsersRepository,
    private readonly tags: TagsService,
    private readonly comments: CommentsService,
    private readonly attachments: AttachmentsService,
    private readonly disk: StorageDisk,
  ) {}

  async seed(context: FeatureDemoContext) {
    const tags = await this.createTags(context);
    for (const note of DEMO_NOTES) {
      await this.createNote(context, note, tags);
    }
    return { notes: DEMO_NOTES.length, tags: DEMO_TAGS.length };
  }

  private async createTags({ system, tx, assertCan }: FeatureDemoContext) {
    await assertCan('manageTags', 'Access');
    const ids = new Map<string, string>();
    for (const tag of DEMO_TAGS) {
      // A tenant that has one by that name already (TENANCY=single fills
      // the existing tenant): the demo notes get it, unchanged.
      const [existing] = await tx
        .select({ id: tagsTable.id })
        .from(tagsTable)
        .where(
          and(
            eq(tagsTable.subject, 'Note'),
            sql`lower(${tagsTable.name}) = lower(${tag.name})`,
          ),
        );
      if (existing) {
        ids.set(tag.key, existing.id);
        continue;
      }
      const created = await this.tags.create(system, {
        subject: 'Note',
        name: tag.name,
        color: tag.color,
      });
      ids.set(tag.key, created.id);
    }
    return ids;
  }

  private async createNote(
    { system, tenantId, users, stored, assertCan }: FeatureDemoContext,
    note: (typeof DEMO_NOTES)[number],
    tags: Map<string, string>,
  ) {
    await assertCan('create', 'Note');
    const owner = await this.users.inTenant(
      users.get(note.owner)!.id,
      tenantId,
    );
    const created = await this.notes.create(
      owner!,
      { title: note.title, body: note.body },
      { by: system },
    );
    const record = { subject: 'Note', recordId: created.id };
    await this.tags.setTags(
      system,
      record,
      note.tags.map((key) => tags.get(key)!),
    );
    for (const comment of note.comments ?? []) {
      // `@maya` in the data: a mention of her address.
      const body = comment.replace(/@([a-z]+)/g, (mention, key: string) =>
        users.has(key) ? `@${users.get(key)!.email}` : mention,
      );
      await this.comments.add(system, record, body);
    }
    if (note.file) {
      await this.attachments.assertCanUpload(system, record);
      const content = Buffer.from(note.file.text, 'utf8');
      const contentType = 'text/plain; charset=utf-8';
      // Under the tenant's prefix, as an upload's (docs/tenancy.md).
      const key = tenantFileKey(tenantId, `attachments/${randomUUID()}.txt`);
      stored.push(key);
      await this.disk.put(key, content, { contentType });
      await this.attachments.attachStored(system, record, {
        key,
        name: note.file.name,
        size: content.length,
        contentType,
      });
    }
  }
}
