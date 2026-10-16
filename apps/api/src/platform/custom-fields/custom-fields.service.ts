import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import type { List } from '../../core/http/list-query.js';
import {
  and,
  asc,
  count,
  eq,
  getTableColumns,
  max,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import { REDIS } from '../../core/redis/redis.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { defineResource } from '../../iam/resources/resource.js';
import { PLATFORM_OPTIONS, type PlatformOptions } from '../platform.options.js';
import { customFilterFields } from './custom-field.list.js';
import type {
  CustomFieldDefinition,
  CustomFieldOption,
  CustomFieldsDeclaration,
  CustomFieldType,
  CustomFieldValidation,
} from './custom-field.types.js';
import type {
  ImportColumn,
  TransferColumn,
} from '../data-transfer/data-transfer.types.js';
import {
  coerceImported,
  customValuesSchema,
  definitionIssues,
  TEXT_LIMITS,
} from './custom-field.values.js';
import { customFieldDefinitions } from './custom-fields.tables.js';

/** Definition changes are audited like any resource: customField.created / .updated. */
export const CUSTOM_FIELD = defineResource({
  subject: 'CustomField',
  audit: { ignore: ['createdAt', 'updatedAt'] },
});

/** How an import template describes each field type (the rest: text). */
const IMPORT_TYPES: Partial<Record<CustomFieldType, ImportColumn['type']>> = {
  number: 'number',
  boolean: 'boolean',
  date: 'date',
  multiSelect: 'list',
};

/** Active fields a subject may have: each is a key in every record's JSONB and a column in exports. */
export const MAX_ACTIVE_FIELDS = 100;

/** Type changes that keep every stored value valid: they're allowed even when values exist. */
const SAFE_TYPE_CHANGES: Partial<Record<CustomFieldType, CustomFieldType[]>> = {
  text: ['longText'],
  email: ['text', 'longText'],
  url: ['text', 'longText'],
};

export interface CreateCustomField {
  subject: string;
  key: string;
  label: string;
  description?: string | null;
  type: CustomFieldType;
  options?: CustomFieldOption[];
  required?: boolean;
  default?: unknown;
  validation?: CustomFieldValidation;
  position?: number;
  filterable?: boolean;
  sortable?: boolean;
}

export type UpdateCustomField = Partial<
  Omit<
    CreateCustomField,
    'subject' | 'key' | 'position' | 'options' | 'validation'
  >
> & {
  options?: CustomFieldOption[] | null;
  validation?: CustomFieldValidation | null;
  active?: boolean;
};

interface Cached {
  version: string | undefined;
  loadedAt: number;
  fields: CustomFieldDefinition[];
  create?: z.ZodType<Record<string, unknown>, Record<string, unknown>>;
  /** Lists extended with these fields, per base list (extendList). */
  lists?: WeakMap<List, List>;
  update?: z.ZodType<Record<string, unknown>, Record<string, unknown>>;
}

/**
 * Custom fields: the definitions administrators manage, and the checks of
 * the values records carry.
 *
 * Definitions are read on every write of a record that has them, so they're
 * cached per subject (with the Zod schemas built from them). Several
 * instances: every change increments a version in Redis
 * (`custom-fields:version`) after its commit, and each read compares it
 * with the cached one (one GET, cheaper than reading the definitions and
 * kinder to the database pool), so a change applies on the next request
 * everywhere. Without Redis the cache holds for FALLBACK_TTL_MS at most.
 */
@Injectable()
export class CustomFieldsService {
  private readonly logger = new Logger('CustomFields');
  private readonly cache = new Map<string, Cached>();
  private readonly declarations: Map<string, CustomFieldsDeclaration>;
  private static readonly VERSION_KEY = 'custom-fields:version';
  private static readonly FALLBACK_TTL_MS = 5_000;
  /** Even with a version, a cached entry is read again after this. */
  private static readonly MAX_AGE_MS = 5 * 60_000;

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PLATFORM_OPTIONS) options: PlatformOptions,
    private readonly audit: AuditService,
  ) {
    this.declarations = new Map();
    for (const declaration of options.customFields ?? []) {
      if (this.declarations.has(declaration.subject)) {
        throw new Error(
          `Custom fields of ${declaration.subject} are declared twice.`,
        );
      }
      this.declarations.set(declaration.subject, declaration);
    }
  }

  /** The subjects that take custom fields. */
  subjects() {
    return [...this.declarations.keys()];
  }

  /** The declaration of a subject, or a 404. */
  declaration(subject: string) {
    const declaration = this.declarations.get(subject);
    if (!declaration) {
      throw new NotFoundException(`${subject} has no custom fields.`);
    }
    return declaration;
  }

  /** A subject's fields in their order; inactive ones too when asked. Cached. */
  async definitions(
    subject: string,
    { includeInactive = false } = {},
  ): Promise<CustomFieldDefinition[]> {
    const { fields } = await this.load(subject);
    return includeInactive ? fields : fields.filter((field) => field.active);
  }

  /**
   * The `custom` of a write, checked against the subject's active fields:
   * a 400 naming each wrong field (`custom.region`) otherwise. On create,
   * defaults are filled in; on update, the result is a patch for
   * `mergeValues()` (`null`: remove the key). Call it before the write's
   * transaction (it may read the definitions).
   */
  async parseValues(
    subject: string,
    input: Record<string, unknown> | undefined,
    mode: 'create' | 'update',
  ): Promise<Record<string, unknown>> {
    if (mode === 'update' && input === undefined) {
      return {};
    }
    const schema = await this.schema(subject, mode);
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The request is invalid.',
        errors: parsed.error.issues.map((issue) => ({
          path: ['custom', ...issue.path].join('.'),
          message: issue.message,
        })),
      });
    }
    return parsed.data;
  }

  /**
   * The SQL that applies a patch from `parseValues(…, 'update')` to the
   * JSONB column: `(custom || '{"a":1}') - array['b']`. Only the keys sent
   * change; `null` removes one; keys of inactive fields stay.
   */
  mergeValues(column: AnyPgColumn, patch: Record<string, unknown>): SQL {
    const set = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== null),
    );
    const removed = Object.keys(patch).filter((key) => patch[key] === null);
    let value: SQL = sql`${column}`;
    if (Object.keys(set).length) {
      value = sql`(${value} || ${JSON.stringify(set)}::jsonb)`;
    }
    if (removed.length) {
      value = sql`(${value} - array[${sql.join(
        removed.map((key) => sql`${key}`),
        sql`, `,
      )}]::text[])`;
    }
    return value;
  }

  /**
   * Export columns for the subject's active fields, after the feature's own:
   * header `<valuesField>.<key>` (`custom.region`: stable, unlike a label an
   * administrator renames, and never mistaken for a built-in column), read
   * from the record's values column. A date field is a `date` column: Excel
   * gets date cells.
   */
  async transferColumns(
    subject: string,
    valuesField = 'custom',
  ): Promise<TransferColumn[]> {
    return (await this.definitions(subject)).map((field) => ({
      key: `${valuesField}.${field.key}`,
      ...(field.type === 'date' && { type: 'date' as const }),
      value: (row: Record<string, unknown>) =>
        (row[valuesField] as Record<string, unknown> | undefined)?.[field.key],
    }));
  }

  /**
   * The `<valuesField>.<key>` columns of an import file, for its template:
   * type, choices (their labels, as people know them: `importSchema` takes
   * a label or a value), limits and whether a value is needed, from the
   * definitions (the checks themselves are `importSchema`'s).
   */
  async importColumns(
    subject: string,
    valuesField = 'custom',
  ): Promise<ImportColumn[]> {
    return (await this.definitions(subject)).map((field) => {
      const rules = field.validation ?? {};
      const label = (value: unknown) =>
        field.options?.find((option) => option.value === value)?.label ?? value;
      const column: ImportColumn = {
        name: `${valuesField}.${field.key}`,
        type: IMPORT_TYPES[field.type] ?? 'text',
        // A required field with a default is filled in when left empty.
        required: field.required && field.defaultValue == null,
        description: field.description
          ? `${field.label}: ${field.description}`
          : field.label,
      };
      const options = field.options?.map((option) => option.label);
      if (options?.length) column.options = options;
      const min = rules.minLength ?? rules.min;
      const max = rules.maxLength ?? rules.max ?? TEXT_LIMITS[field.type];
      if (min !== undefined) column.min = min;
      if (max !== undefined) column.max = max;
      if (field.defaultValue != null) {
        // The default as the dropdown shows it: a choice's label.
        column.example = Array.isArray(field.defaultValue)
          ? field.defaultValue.map(label)
          : label(field.defaultValue);
      }
      return column;
    });
  }

  /**
   * The columns of an import file no row could pass: `<valuesField>.<key>`
   * headers of fields that don't exist or are no longer active (an export
   * made before a field was deactivated). Checked once, before any row.
   */
  async unknownColumns(
    subject: string,
    headers: readonly string[],
    valuesField = 'custom',
  ): Promise<string[]> {
    const prefix = `${valuesField}.`;
    const known = new Set(
      (await this.definitions(subject)).map((field) => field.key),
    );
    return headers.filter(
      (header) =>
        header.startsWith(prefix) && !known.has(header.slice(prefix.length)),
    );
  }

  /**
   * An import row schema: `base` (the feature's own columns) plus the
   * subject's `<valuesField>.<key>` columns (a JSON file may nest them
   * instead, `custom: { key: value }`, as a POST body does), converted from
   * text to each type (a choice's label stands for its value) and checked
   * as on create. The output's values field holds the values the file set:
   * defaults are left to the service's `parseValues`, as on POST, so a row
   * that sets no custom value needs no permission on that field. Errors
   * name `<valuesField>.<key>`.
   */
  async importSchema<T extends z.ZodObject, F extends string = 'custom'>(
    subject: string,
    base: T,
    valuesField: F = 'custom' as F,
  ) {
    const fields = new Map(
      (await this.definitions(subject)).map((field) => [field.key, field]),
    );
    const values = await this.schema(subject, 'create');
    const prefix = `${valuesField}.`;
    return base.loose().transform((record, ctx) => {
      const raw = new Map<string, unknown>();
      const rest: Record<string, unknown> = {};
      let twice = false;
      const nested = record[valuesField];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        for (const [key, value] of Object.entries(nested)) {
          raw.set(key, value);
        }
      }
      for (const [column, value] of Object.entries(record)) {
        if (column === valuesField) continue;
        if (!column.startsWith(prefix)) {
          rest[column] = value;
          continue;
        }
        const key = column.slice(prefix.length);
        if (raw.has(key)) {
          twice = true;
          ctx.addIssue({
            code: 'custom',
            path: [valuesField, key],
            message: `Given twice: as a column and inside ${valuesField}.`,
          });
        }
        raw.set(key, value);
      }
      const custom: Record<string, unknown> = {};
      for (const [key, value] of raw) {
        const field = fields.get(key);
        // Unknown keys are passed on: the values schema refuses them by name.
        const coerced = field ? coerceImported(field, value) : value;
        if (coerced !== undefined) custom[key] = coerced;
      }
      const parsed = values.safeParse(custom);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: 'custom',
            path: [valuesField, ...issue.path],
            message: issue.message,
          });
        }
      }
      if (!parsed.success || twice) {
        return z.NEVER;
      }
      // Only the base schema's own keys, and the checked values the file set
      // (not the defaults the check filled in: the service fills them).
      const own = Object.fromEntries(
        Object.keys(base.shape).map((key) => [key, rest[key]]),
      );
      const set = Object.fromEntries(
        Object.entries(parsed.data).filter(([key]) => key in custom),
      );
      return { ...own, [valuesField]: set } as z.infer<T> &
        Record<F, Record<string, unknown>>;
    });
  }

  /**
   * Records as clients see them: only the values of ACTIVE fields in their
   * custom values (a deactivated field's values stay stored, hidden until
   * it's reactivated).
   */
  async visible<T extends object>(subject: string, records: T[]): Promise<T[]> {
    const { table, column } = this.declaration(subject);
    const name = Object.entries(getTableColumns(table)).find(
      ([, value]) => value === column,
    )?.[0];
    if (!name) {
      return records;
    }
    const active = new Set(
      (await this.definitions(subject)).map((field) => field.key),
    );
    return records.map((record) => {
      const values = (record as Record<string, unknown>)[name];
      if (!values || typeof values !== 'object') {
        return record;
      }
      return {
        ...record,
        [name]: Object.fromEntries(
          Object.entries(values).filter(([key]) => active.has(key)),
        ),
      };
    });
  }

  /**
   * `list` with the subject's custom fields (filter, sort, `fields`), built
   * once per definitions version: validate a list query with its `schema`.
   */
  async extendList(list: List, subject: string): Promise<List> {
    const declaration = this.declaration(subject);
    const entry = await this.load(subject);
    entry.lists ??= new WeakMap();
    let extended = entry.lists.get(list);
    if (!extended) {
      const { fields, select } = customFilterFields(
        entry.fields,
        declaration.column,
      );
      extended = list.extend(fields, select);
      entry.lists.set(list, extended);
    }
    return extended;
  }

  // Definitions: managed by Access.manageCustomFields.

  async create(actor: Principal, input: CreateCustomField, ip?: string) {
    this.declaration(input.subject);
    const definition = {
      type: input.type,
      options: input.options ?? null,
      validation: input.validation ?? null,
      defaultValue: input.default ?? null,
    };
    this.assertValid(definition);
    const row = await inTransaction(this.txHost, async (tx) => {
      const [existing] = await tx
        .select({ id: customFieldDefinitions.id })
        .from(customFieldDefinitions)
        .where(
          and(
            eq(customFieldDefinitions.subject, input.subject),
            eq(customFieldDefinitions.key, input.key),
          ),
        );
      if (existing) {
        throw new ConflictException({
          code: 'custom_field_exists',
          message: `${input.subject} already has a field "${input.key}" (keys are never reused, even after a field is deactivated).`,
        });
      }
      await this.assertRoom(tx, input.subject);
      const [{ last }] = await tx
        .select({ last: max(customFieldDefinitions.position) })
        .from(customFieldDefinitions)
        .where(eq(customFieldDefinitions.subject, input.subject));
      const [created] = await tx
        .insert(customFieldDefinitions)
        .values({
          subject: input.subject,
          key: input.key,
          label: input.label,
          description: input.description ?? null,
          ...definition,
          required: input.required ?? false,
          position: input.position ?? (last ?? -1) + 1,
          filterable: input.filterable ?? false,
          sortable: input.sortable ?? false,
        })
        .returning();
      await this.audit.recordChange(
        actor,
        CUSTOM_FIELD,
        { action: 'created', id: created.id, after: created },
        tx,
        ip,
      );
      return created;
    });
    await this.changed();
    return row as CustomFieldDefinition;
  }

  /**
   * Changes a field. Its key and subject never change. A type change is
   * refused (409) while any record holds a value, unless every value stays
   * valid (text → longText, email/url → text or longText); so is removing a
   * choice that records hold. Values already stored aren't checked again
   * against new limits: they are on their next write.
   */
  async update(
    actor: Principal,
    id: string,
    input: UpdateCustomField,
    ip?: string,
  ) {
    const row = await inTransaction(this.txHost, async (tx) => {
      const before = await this.find(tx, id);
      const declaration = this.declaration(before.subject);
      const next = {
        type: input.type ?? before.type,
        options: input.options !== undefined ? input.options : before.options,
        validation:
          input.validation !== undefined ? input.validation : before.validation,
        defaultValue:
          input.default !== undefined ? input.default : before.defaultValue,
      };
      if (
        input.type &&
        input.type !== before.type &&
        !SAFE_TYPE_CHANGES[before.type]?.includes(input.type)
      ) {
        // The options of the old type mean nothing to the new one.
        if (input.options === undefined && !hasOptions(input.type)) {
          next.options = null;
        }
        if (await this.holdsValues(tx, declaration, before.key)) {
          throw new ConflictException({
            code: 'custom_field_in_use',
            message: `Records hold values of "${before.key}": its type can't change from ${before.type} to ${input.type}. Add a new field instead.`,
          });
        }
      }
      if (input.options !== undefined && hasOptions(before.type)) {
        const kept = new Set((input.options ?? []).map((o) => o.value));
        const removed = (before.options ?? [])
          .map((option) => option.value)
          .filter((value) => !kept.has(value));
        for (const value of removed) {
          const holds = await this.holdsValues(
            tx,
            declaration,
            before.key,
            before.type === 'multiSelect' ? [value] : value,
          );
          if (holds) {
            throw new ConflictException({
              code: 'custom_field_in_use',
              message: `Records hold the choice "${value}" of "${before.key}": it can't be removed.`,
            });
          }
        }
      }
      this.assertValid(next);
      if (input.active && !before.active) {
        await this.assertRoom(tx, before.subject);
      }
      const [after] = await tx
        .update(customFieldDefinitions)
        .set({
          ...(input.label !== undefined && { label: input.label }),
          ...(input.description !== undefined && {
            description: input.description,
          }),
          ...(input.required !== undefined && { required: input.required }),
          ...(input.filterable !== undefined && {
            filterable: input.filterable,
          }),
          ...(input.sortable !== undefined && { sortable: input.sortable }),
          ...(input.active !== undefined && { active: input.active }),
          ...next,
          updatedAt: new Date(),
        })
        .where(eq(customFieldDefinitions.id, id))
        .returning();
      await this.audit.recordChange(
        actor,
        CUSTOM_FIELD,
        { action: 'updated', id, before, after },
        tx,
        ip,
      );
      return after;
    });
    await this.changed();
    return row as CustomFieldDefinition;
  }

  /** Deactivates a field: no longer accepted or exported; the values records hold stay. */
  deactivate(actor: Principal, id: string, ip?: string) {
    return this.update(actor, id, { active: false }, ip);
  }

  /**
   * Puts these fields of `subject` first, in this order; the others follow
   * in their current order.
   */
  async reorder(actor: Principal, subject: string, ids: string[], ip?: string) {
    this.declaration(subject);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('A field is listed twice.');
    }
    const fields = await inTransaction(this.txHost, async (tx) => {
      const current = await tx
        .select()
        .from(customFieldDefinitions)
        .where(eq(customFieldDefinitions.subject, subject))
        .orderBy(
          asc(customFieldDefinitions.position),
          asc(customFieldDefinitions.key),
        );
      const known = new Set(current.map((field) => field.id));
      const unknown = ids.filter((id) => !known.has(id));
      if (unknown.length) {
        throw new BadRequestException(
          `Not fields of ${subject}: ${unknown.join(', ')}.`,
        );
      }
      const order = [
        ...ids,
        ...current.map((field) => field.id).filter((id) => !ids.includes(id)),
      ];
      for (const [position, id] of order.entries()) {
        await tx
          .update(customFieldDefinitions)
          .set({ position, updatedAt: new Date() })
          .where(eq(customFieldDefinitions.id, id));
      }
      await this.audit.record(
        actor,
        {
          action: 'customField.reordered',
          targetType: 'customField',
          details: {
            subject,
            from: current.map((field) => field.key),
            to: order.map((id) => current.find((f) => f.id === id)!.key),
          },
          ip,
        },
        tx,
      );
      return tx
        .select()
        .from(customFieldDefinitions)
        .where(eq(customFieldDefinitions.subject, subject))
        .orderBy(asc(customFieldDefinitions.position));
    });
    await this.changed();
    return fields as CustomFieldDefinition[];
  }

  /** One definition, or a 404. */
  async findOne(id: string) {
    return this.find(this.db, id);
  }

  private async find(db: Database | Transaction, id: string) {
    const [field] = await db
      .select()
      .from(customFieldDefinitions)
      .where(eq(customFieldDefinitions.id, id));
    if (!field) {
      throw new NotFoundException(`Custom field ${id} not found.`);
    }
    return field as CustomFieldDefinition;
  }

  private assertValid(
    definition: Parameters<typeof definitionIssues>[0],
  ): void {
    const issues = definitionIssues(definition);
    if (issues.length) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The field definition is invalid.',
        errors: issues,
      });
    }
  }

  private async assertRoom(tx: Transaction, subject: string) {
    const [{ active }] = await tx
      .select({ active: count() })
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.subject, subject),
          eq(customFieldDefinitions.active, true),
        ),
      );
    if (active >= MAX_ACTIVE_FIELDS) {
      throw new ConflictException({
        code: 'custom_field_limit',
        message: `${subject} has ${MAX_ACTIVE_FIELDS} active fields, the most it may have: deactivate one first.`,
      });
    }
  }

  /**
   * Whether any record holds a value for `key` (or this value: a choice).
   * Both forms use the column's GIN index: `custom ? 'key'`, `custom @> '{…}'`.
   */
  private async holdsValues(
    tx: Transaction,
    declaration: CustomFieldsDeclaration,
    key: string,
    value?: unknown,
  ) {
    const condition =
      value === undefined
        ? sql`${declaration.column} ? ${key}`
        : sql`${declaration.column} @> ${JSON.stringify({ [key]: value })}::jsonb`;
    const rows = await tx
      .select({ one: sql<number>`1` })
      .from(declaration.table)
      .where(condition)
      .limit(1);
    return rows.length > 0;
  }

  /** After a committed change: this instance's cache now, the others' on their next read. */
  private async changed() {
    this.cache.clear();
    await this.redis
      .incr(CustomFieldsService.VERSION_KEY)
      .catch((error: unknown) =>
        this.logger.warn(
          `Could not publish a custom field change; other instances see it within ${CustomFieldsService.FALLBACK_TTL_MS} ms.`,
          { error: String(error) },
        ),
      );
  }

  private async version(): Promise<string | undefined> {
    try {
      return (await this.redis.get(CustomFieldsService.VERSION_KEY)) ?? '0';
    } catch {
      return undefined; // Redis away: fall back to a short TTL
    }
  }

  private async load(subject: string): Promise<Cached> {
    this.declaration(subject);
    const version = await this.version();
    const cached = this.cache.get(subject);
    const age = cached ? Date.now() - cached.loadedAt : Infinity;
    if (
      cached &&
      age < CustomFieldsService.MAX_AGE_MS &&
      (version !== undefined && cached.version !== undefined
        ? cached.version === version
        : age < CustomFieldsService.FALLBACK_TTL_MS)
    ) {
      return cached;
    }
    const fields = (await this.db
      .select()
      .from(customFieldDefinitions)
      .where(eq(customFieldDefinitions.subject, subject))
      .orderBy(
        asc(customFieldDefinitions.position),
        asc(customFieldDefinitions.key),
      )) as CustomFieldDefinition[];
    const entry: Cached = { version, loadedAt: Date.now(), fields };
    this.cache.set(subject, entry);
    return entry;
  }

  private async schema(subject: string, mode: 'create' | 'update') {
    const entry = await this.load(subject);
    return (entry[mode] ??= customValuesSchema(
      entry.fields.filter((field) => field.active),
      mode,
    ));
  }
}

const hasOptions = (type: CustomFieldType) =>
  type === 'select' || type === 'multiSelect';
