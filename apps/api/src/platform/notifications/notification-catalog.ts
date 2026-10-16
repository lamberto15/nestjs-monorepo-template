import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import type { Principal } from '../../iam/auth/principal.js';
import { PLATFORM_OPTIONS, type PlatformOptions } from '../platform.options.js';
import { NotificationChannelRegistry } from './notification-channel.registry.js';
import {
  effectiveSettings,
  preferencesSchema,
  settableChannels,
} from './notification-preferences.js';
import type { NotificationTypeDeclaration } from './notification.types.js';

/**
 * The notification types the features declared (`PlatformModule.forRoot({
 * notifications })`), their texts, and what each recipient's preferences
 * make of them. Checked once the channels have registered: a declaration
 * naming an unknown channel, a default its schema refuses, or a type the
 * English catalog lacks stops the start.
 */
@Injectable()
export class NotificationCatalog implements OnApplicationBootstrap {
  private readonly byType = new Map<string, NotificationTypeDeclaration<any>>();

  constructor(
    @Inject(PLATFORM_OPTIONS) options: PlatformOptions,
    private readonly registry: NotificationChannelRegistry,
    private readonly i18n: I18nService,
  ) {
    for (const declaration of options.notifications ?? []) {
      if (this.byType.has(declaration.type)) {
        throw new Error(
          `Notification type "${declaration.type}" is declared twice.`,
        );
      }
      this.byType.set(declaration.type, declaration);
    }
  }

  onApplicationBootstrap() {
    for (const declaration of this.byType.values()) {
      const defaults = (declaration.channels ?? {}) as Record<string, unknown>;
      for (const [name, value] of Object.entries(defaults)) {
        const channel = this.registry.get(name);
        if (!channel?.settings) {
          throw new Error(
            `Notification type "${declaration.type}" names the channel "${name}", which ${channel ? 'takes no setting' : 'is not registered'}.`,
          );
        }
        if (
          value !== undefined &&
          !channel.settings.schema.safeParse(value).success
        ) {
          throw new Error(
            `Notification type "${declaration.type}": "${name}" cannot be ${JSON.stringify(value)}.`,
          );
        }
      }
      for (const part of ['label', 'title', 'body']) {
        const key = `notifications.${declaration.type}.${part}`;
        if (!this.i18n.exists(key, this.i18n.defaultLocale)) {
          throw new Error(
            `The ${this.i18n.defaultLocale} catalog has no ${key} (src/i18n/${this.i18n.defaultLocale}/notifications.json).`,
          );
        }
      }
    }
  }

  /** The declared types, in declaration order. */
  declarations() {
    return [...this.byType.values()];
  }

  /** A declared type, or undefined (removed since the notification was stored). */
  declaration(type: string) {
    return this.byType.get(type);
  }

  /** The names of the channels this recipient may set. */
  settable(recipient: Principal) {
    return settableChannels(this.registry.all(), recipient).map(
      (channel) => channel.name,
    );
  }

  /** The channels a notification of `type` goes through for this recipient, by name, with their settings. */
  effective(
    declaration: NotificationTypeDeclaration<any>,
    overrides: Record<string, unknown> | undefined,
    recipient: Principal,
  ) {
    return effectiveSettings(
      declaration,
      overrides,
      recipient,
      this.registry.all(),
    );
  }

  /** The schema of this recipient's `PUT /notifications/preferences`. */
  preferencesSchema(recipient: Principal) {
    return preferencesSchema(
      this.declarations(),
      recipient,
      this.registry.all(),
    );
  }

  /**
   * A notification's texts in `locale` (the current request's when none),
   * from its type and data; `count` picks the plural form. A type that is
   * no longer declared shows as its name.
   */
  render(
    type: string,
    data: Record<string, unknown>,
    count: number,
    locale?: string,
  ): { title: string; body: string } {
    if (!this.byType.has(type)) {
      return { title: type, body: '' };
    }
    const args = { ...data, count };
    return {
      title: this.i18n.translate(`notifications.${type}.title`, {
        locale,
        args,
      }),
      body: this.i18n.translate(`notifications.${type}.body`, {
        locale,
        args,
      }),
    };
  }

  /** What a type is called, for people, in `locale` (the current request's when none). */
  label(type: string, locale?: string) {
    return this.i18n.translate(`notifications.${type}.label`, { locale });
  }
}
