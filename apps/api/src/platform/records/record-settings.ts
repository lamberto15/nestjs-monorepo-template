import { z } from 'zod';
import {
  flag,
  type SettingDeclaration,
  type SettingScope,
  setting,
} from '../settings/setting.types.js';
import type { RecordDeclaration } from './record.js';

/**
 * The settings and flags a record declares (`settings` in
 * `<item>.record.ts`), one line each:
 *
 * ```ts
 * settings: {
 *   paymentDays: recordSetting.int(30).min(1).max(365),
 *   autoSend: recordSetting.flag(),
 *   tone: recordSetting.enum(['formal', 'casual'], 'formal').scopes(['tenant', 'user']),
 * },
 * ```
 *
 * The platform declares them (`recordSettings(INVOICE)`, handed to
 * `PlatformModule.forRoot({ settings })` by `featureDeclarations`), under the
 * key `<path in camelCase>.<name>` (`invoices.paymentDays`): administrators
 * change them at `/v1/settings` ([settings](../../../../../docs/settings.md)),
 * the feature reads them with `settings.get(recordSettings(INVOICE).paymentDays)`.
 * No migration, no route, no text: the declaration is all there is.
 */
export class RecordSettingSpec<T = unknown> {
  constructor(
    readonly kind: 'flag' | 'int' | 'string' | 'enum',
    readonly initial: T,
    readonly options: {
      values?: readonly string[];
      min?: number;
      max?: number;
      label?: string;
      description?: string;
      scopes?: readonly SettingScope[];
      private?: boolean;
    } = {},
  ) {}

  private with(options: RecordSettingSpec['options']) {
    return new RecordSettingSpec<T>(this.kind, this.initial, {
      ...this.options,
      ...options,
    });
  }

  /** The smallest value (a number). */
  min(min: number) {
    return this.with({ min });
  }
  /** The largest value (a number). */
  max(max: number) {
    return this.with({ max });
  }
  /** What it is called (default: the name in words). */
  label(label: string) {
    return this.with({ label });
  }
  /** What it does, for the settings page. */
  describe(description: string) {
    return this.with({ description });
  }
  /** Where it may be set (default: `['tenant']`, a flag every scope). */
  scopes(scopes: readonly SettingScope[]) {
    return this.with({ scopes });
  }
  /** Shown only to those who manage settings (default: to every caller). */
  hidden() {
    return this.with({ private: true });
  }
}

/** The kinds of setting a record can declare (`recordSetting.int(30)`). */
export const recordSetting = {
  /** On or off (a feature flag: also rolls out to a share of principals). */
  flag: (initial = false) => new RecordSettingSpec<boolean>('flag', initial),
  /** A whole number. */
  int: (initial: number) => new RecordSettingSpec<number>('int', initial),
  /** A short text. */
  string: (initial: string) => new RecordSettingSpec<string>('string', initial),
  /** One of a few values. */
  enum: <const V extends readonly [string, ...string[]]>(
    values: V,
    initial: V[number],
  ) =>
    new RecordSettingSpec<V[number]>('enum', initial, {
      values,
    }),
};

/** `invoice-lines` → `invoiceLines`: the key's first part. */
export const camelPath = (path: string) =>
  path.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

/** `paymentDays` → `Payment days`. */
export const wordsOf = (name: string) => {
  const spaced = name.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
  return spaced[0]!.toUpperCase() + spaced.slice(1);
};

/** A setting's key: `invoices.paymentDays`. */
export const recordSettingKey = (
  declaration: RecordDeclaration,
  name: string,
) => `${camelPath(declaration.path)}.${name}`;

function declare(
  declaration: RecordDeclaration,
  name: string,
  spec: RecordSettingSpec,
): SettingDeclaration {
  const { options } = spec;
  const base = {
    key: recordSettingKey(declaration, name),
    label: options.label ?? wordsOf(name),
    description: options.description,
    ...(options.scopes && { scopes: options.scopes }),
    ...(options.private && { public: false }),
  };
  if (spec.kind === 'flag') {
    return flag({ ...base, default: spec.initial as boolean });
  }
  const schema =
    spec.kind === 'int'
      ? intSchema(options.min, options.max)
      : spec.kind === 'enum'
        ? z.enum(options.values as [string, ...string[]])
        : z.string().max(500);
  return setting({ ...base, schema, default: spec.initial });
}

const intSchema = (min?: number, max?: number) => {
  let schema = z.number().int();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return schema;
};

type SettingValue<S> = S extends RecordSettingSpec<infer T> ? T : never;

/** A record's declared settings, by name. */
export type RecordSettings<D extends RecordDeclaration> = {
  [K in keyof NonNullable<D['settings']> & string]: SettingDeclaration<
    SettingValue<NonNullable<D['settings']>[K]>
  >;
};

const BUILT = new WeakMap<
  RecordDeclaration,
  Record<string, SettingDeclaration>
>();

/**
 * The settings a record declares, by name, each declared once per
 * declaration (the same objects every call: the platform registers them
 * by key).
 */
export function recordSettings<const D extends RecordDeclaration>(
  declaration: D,
): RecordSettings<D> {
  let built = BUILT.get(declaration);
  if (!built) {
    built = Object.fromEntries(
      Object.entries(declaration.settings ?? {}).map(([name, spec]) => [
        name,
        declare(declaration, name, spec),
      ]),
    );
    BUILT.set(declaration, built);
  }
  return built as RecordSettings<D>;
}
