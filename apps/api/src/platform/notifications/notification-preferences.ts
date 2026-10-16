import { z } from 'zod';
import type { Principal } from '../../iam/auth/principal.js';
import type {
  NotificationChannel,
  NotificationTypeDeclaration,
} from './notification.types.js';

/**
 * How a recipient's preferences combine with the types' defaults. Pure
 * functions, so they can be read and tested apart from the services.
 */

/** The channels a recipient may set: those with a setting, that reach their kind. */
export const settableChannels = (
  channels: readonly NotificationChannel[],
  recipient: Principal,
) =>
  channels.filter(
    (channel) => channel.settings !== undefined && channel.supports(recipient),
  ) as (NotificationChannel & {
    settings: NonNullable<NotificationChannel['settings']>;
  })[];

/** Settings are small values (a boolean, a mode): equal when their JSON is. */
export const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The effective setting of each channel the recipient may set, for one
 * type: their override when it is valid, else the type's default, else
 * off. A mandatory type keeps its default where an override would switch
 * the channel off (the preferences API refuses such an override; this
 * guards stored ones against a type that became mandatory since).
 */
export function effectiveSettings(
  declaration: NotificationTypeDeclaration<any>,
  overrides: Record<string, unknown> | undefined,
  recipient: Principal,
  channels: readonly NotificationChannel[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const channel of settableChannels(channels, recipient)) {
    const { schema, off } = channel.settings;
    const fallback =
      (declaration.channels as Record<string, unknown> | undefined)?.[
        channel.name
      ] ?? off;
    const override = overrides?.[channel.name];
    const parsed =
      override === undefined ? undefined : schema.safeParse(override);
    let value = parsed?.success ? parsed.data : fallback;
    if (declaration.mandatory && same(value, off) && !same(fallback, off)) {
      value = fallback;
    }
    result[channel.name] = value;
  }
  return result;
}

/**
 * The schema of `PUT /notifications/preferences` for this recipient: the
 * declared types, each with the channels the recipient may set (a client
 * sending `email` is refused by name); a mandatory type refuses the value
 * that means off. Errors name `<type>.<channel>`.
 */
export function preferencesSchema(
  declarations: readonly NotificationTypeDeclaration<any>[],
  recipient: Principal,
  channels: readonly NotificationChannel[],
) {
  const settable = settableChannels(channels, recipient);
  const settableNames = new Set(settable.map((channel) => channel.name));
  const perType = (declaration: NotificationTypeDeclaration<any>) =>
    z
      .looseObject(
        Object.fromEntries(
          settable.map((channel) => [
            channel.name,
            channel.settings.schema.optional(),
          ]),
        ),
      )
      .superRefine((value, ctx) => {
        for (const name of Object.keys(value)) {
          if (!settableNames.has(name)) {
            ctx.addIssue({
              code: 'custom',
              path: [name],
              message: 'Not a channel you can set.',
            });
          }
        }
        if (!declaration.mandatory) return;
        for (const channel of settable) {
          const given = value[channel.name];
          if (given !== undefined && same(given, channel.settings.off)) {
            ctx.addIssue({
              code: 'custom',
              path: [channel.name],
              message: 'This notification cannot be switched off.',
            });
          }
        }
      });
  const types = new Set<string>(
    declarations.map((declaration) => declaration.type),
  );
  return z
    .looseObject(
      Object.fromEntries(
        declarations.map((declaration) => [
          declaration.type,
          perType(declaration).optional(),
        ]),
      ),
    )
    .superRefine((value, ctx) => {
      for (const type of Object.keys(value)) {
        if (!types.has(type)) {
          ctx.addIssue({
            code: 'custom',
            path: [type],
            message: 'Unknown notification type.',
          });
        }
      }
    });
}
