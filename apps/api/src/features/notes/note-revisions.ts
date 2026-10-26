import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { validationException } from '../../core/http/problem-details.filter.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { CustomFieldsService } from '../../platform/custom-fields/custom-fields.service.js';
import {
  type RevisionItem,
  type RevisionTarget,
  RevisionsRegistry,
} from '../../platform/revisions/revisions.registry.js';
import { NotePolicy } from './note.policy.js';
import { noteSnapshot } from './note.resource.js';
import {
  type Note,
  noteView,
  type UpdateNoteDto,
  updateNoteSchema,
} from './note.schemas.js';
import { NotesService } from './notes.service.js';

/**
 * Notes keep their revisions (platform/revisions): the title, the text and
 * the custom values after each change. Whoever may read a note reads them
 * (the text and custom values only with the permissions that include
 * them); whoever may change it (`Note.update`) restores one, through
 * `NotesService.update`: audited `note.updated`, a new revision.
 */
@Injectable()
export class NoteRevisions implements RevisionTarget {
  readonly subject = 'Note';

  constructor(
    private readonly notes: NotesService,
    private readonly policy: NotePolicy,
    private readonly access: AccessService,
    private readonly customFields: CustomFieldsService,
    registry: RevisionsRegistry,
  ) {
    registry.register(this);
  }

  async canRead(principal: Principal, id: string) {
    const note = await this.find(id);
    return note !== null && this.policy.read(principal, note);
  }

  async canRestore(principal: Principal, id: string) {
    const note = await this.find(id);
    return note !== null && this.policy.update(principal, note);
  }

  snapshot(note: Note) {
    return noteSnapshot(note);
  }

  /**
   * Changes what differs from the snapshot, with the checks of a PATCH
   * (its schema: a value invalid under today's rules is a 400; field-level:
   * `field_forbidden`). Custom values of active fields are
   * set back (a value the snapshot lacks is removed); those of fields
   * deactivated since stay as they are.
   */
  async apply(
    principal: Principal,
    id: string,
    fields: Record<string, unknown>,
    {
      ip,
      restoredFrom,
      unchanged,
    }: {
      ip?: string;
      restoredFrom: number;
      unchanged?: (current: object) => void;
    },
  ) {
    const updated = await this.notes.update(principal, { id }, {}, ip, {
      restoredFrom,
      prepareCurrent: async (current) => {
        const dto: UpdateNoteDto = {};
        if (
          typeof fields.title === 'string' &&
          fields.title !== current.title
        ) {
          dto.title = fields.title;
        }
        if (typeof fields.body === 'string' && fields.body !== current.body) {
          dto.body = fields.body;
        }
        const [then, now] = await this.customFields.visible('Note', [
          { custom: (fields.custom ?? {}) as Record<string, unknown> },
          { custom: current.custom },
        ]);
        const custom: Record<string, unknown> = {};
        for (const key of new Set([
          ...Object.keys(then!.custom),
          ...Object.keys(now!.custom),
        ])) {
          const value = then!.custom[key] ?? null;
          if (
            JSON.stringify(value) !== JSON.stringify(now!.custom[key] ?? null)
          ) {
            custom[key] = value;
          }
        }
        if (Object.keys(custom).length > 0) {
          dto.custom = custom as UpdateNoteDto['custom'];
        }
        const parsed = updateNoteSchema.safeParse(dto);
        if (!parsed.success) {
          throw validationException(parsed.error.issues);
        }
        return parsed.data;
      },
      assertCurrent: async (current, dto) => {
        if (!(await this.policy.update(principal, current))) {
          throw new ForbiddenException('You may not change this Note.');
        }
        unchanged?.(await this.present(principal, current));
        const currentForbidden = await this.access.forbiddenFields(
          principal,
          'update',
          'Note',
          dto,
          current,
        );
        if (currentForbidden.length) {
          throw new ForbiddenException({
            code: 'field_forbidden',
            message: `You may not change: ${currentForbidden.join(', ')}.`,
            fields: currentForbidden,
          });
        }
      },
    });
    return this.present(principal, updated);
  }

  async shown(principal: Principal, id: string) {
    return this.present(principal, await this.notes.findOne(id));
  }

  /**
   * Without the text or custom values when the reader's permissions don't
   * include them, and without the custom fields deactivated since: in the
   * snapshots and in the changes (`custom.<key>`).
   */
  async redact(
    principal: Principal,
    id: string,
    items: RevisionItem[],
  ): Promise<RevisionItem[]> {
    const note = await this.notes.findOne(id);
    const visible = await this.customFields.visible(
      'Note',
      items.map(({ snapshot }) => ({
        ...snapshot,
        custom: (snapshot.custom ?? {}) as Record<string, unknown>,
      })),
    );
    // The custom keys the changes name that are active fields now.
    const named = items.flatMap(({ changes }) =>
      Object.keys(changes ?? {})
        .filter((key) => key.startsWith('custom.'))
        .map((key) => key.slice('custom.'.length)),
    );
    const [probe] = await this.customFields.visible('Note', [
      { custom: Object.fromEntries(named.map((key) => [key, true])) },
    ]);
    const active = new Set(Object.keys(probe!.custom));
    return Promise.all(
      visible.map(async (snapshot, index) => {
        const allowed = await this.access.redact(principal, 'read', 'Note', {
          ...note,
          ...snapshot,
        } as Record<string, unknown>);
        const shown = Object.fromEntries(
          Object.entries(snapshot).filter(([field]) => field in allowed),
        );
        const changes = items[index]!.changes;
        return {
          snapshot: shown,
          changes:
            changes &&
            Object.fromEntries(
              Object.entries(changes).filter(([key]) => {
                const [field, sub] = key.split('.', 2) as [string, string?];
                if (!(field in shown)) return false;
                return (
                  field !== 'custom' || sub === undefined || active.has(sub)
                );
              }),
            ),
        };
      }),
    );
  }

  /** A note as GET /v1/notes/{id} answers it (NotesController.shown): what its ETag covers. */
  private async present(principal: Principal, note: Note) {
    const [shown] = await this.customFields.visible(
      'Note',
      await this.notes.withTags([noteView(note)]),
    );
    return this.access.redact(principal, 'read', 'Note', shown!);
  }

  private async find(id: string): Promise<Note | null> {
    try {
      return await this.notes.findOne(id);
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }
}
