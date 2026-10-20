import type { Type } from '@nestjs/common';
import type { Transaction } from '../core/database/drizzle.js';
import type {
  PermissionInput,
  PermissionsDefinition,
} from '../iam/access/permissions.js';
import type { SystemPrincipal } from '../iam/auth/principal.js';
import type { ResourceDefinition } from '../iam/resources/resource.js';
import { commentedData } from '../platform/comments/comment-notifications.js';
import {
  type DomainEventDeclaration,
  expandDomainEvents,
} from '../platform/events/domain-event.js';
import type { NotificationType } from '../platform/notifications/notification.types.js';
import type { PlatformOptions } from '../platform/platform.options.js';
import { recordApprovalActions } from '../platform/records/record-approvals.js';
import { recordSettings } from '../platform/records/record-settings.js';
import {
  type RecordDeclaration,
  recordEventTypes,
  recordCustomFields,
  recordKey,
  takes,
} from '../platform/records/record.js';

/**
 * Everything a feature hands the groups, in one declaration
 * (`features/<x>/<x>.feature.ts`): its module, its Swagger tag, and what
 * IamModule and PlatformModule take from features. `features/index.ts`
 * lists every feature; app.module.ts and openapi.ts read that list, so a
 * new feature (`pnpm feature:add`) adds one line there and edits no group.
 */
export interface FeatureDefinition {
  /** The feature's Nest module: its controllers and providers. */
  module: Type;
  /** Its routes' Swagger tag (`@ApiTags`), and the tag's description. */
  apiTag: { name: string; description: string };
  /** Its subjects, actions, conditions and seed roles (`definePermissions()`). */
  permissions: PermissionsDefinition;
  /** The resources the platform acts on (soft delete: `defineResource()`). */
  resources?: ResourceDefinition[];
  eventTypes?: PlatformOptions['eventTypes'];
  incomingWebhooks?: PlatformOptions['incomingWebhooks'];
  queues?: PlatformOptions['queues'];
  customFields?: PlatformOptions['customFields'];
  notifications?: PlatformOptions['notifications'];
  settings?: PlatformOptions['settings'];
  approvals?: PlatformOptions['approvals'];
  /** The realtime events it pushes (`defineRealtimeEvents()`). */
  realtimeEvents?: PlatformOptions['realtimeEvents'];
  /**
   * Its domain events (`defineDomainEvents()`): each declared once for the
   * channels that carry it (webhook, notification, realtime). Added to the
   * separate lists above, which stay available.
   */
  events?: readonly DomainEventDeclaration[];
  /**
   * Its records' declaration (`<x>.record.ts`), when they are declared:
   * what their capabilities need of the platform is derived from it (the
   * `<item>.commented` notification with comments, the custom fields'
   * declaration with custom).
   */
  record?: RecordDeclaration;
  /**
   * Its demo data (`pnpm db:seed:demo`): a provider of its module that
   * writes it, and what the seed's system job needs for that (src/demo).
   */
  demo?: {
    seeder: Type<FeatureDemoSeeder>;
    permissions: PermissionInput[];
  };
}

/** What a feature's demo seeder gets: the demo tenant's transaction, its people. */
export interface FeatureDemoContext {
  system: SystemPrincipal;
  tx: Transaction;
  tenantId: string;
  /** The demo users by their key (demo-data.ts): id and address. */
  users: Map<string, { id: string; email: string }>;
  /** Files written to storage: deleted again if the seed fails. */
  stored: string[];
  /** As `@Can()` checks a request: the seed's job must declare it. */
  assertCan: (action: string, subject: string) => Promise<void>;
}

/** A feature's demo data (`FeatureDefinition.demo`): what it made, to report. */
export interface FeatureDemoSeeder {
  seed(context: FeatureDemoContext): Promise<Record<string, number>>;
}

/**
 * The domain events a record's capabilities bring: `<item>.created`,
 * `.updated`, `.deleted` (`.restored`) as webhook event types with `events`,
 * and the `<item>.commented` notification with comments. This is what
 * `pnpm feature:add` relies on: its feature file declares only `record`.
 */
const recordDomainEvents = (
  record: RecordDeclaration | undefined,
): DomainEventDeclaration[] => {
  if (!record) {
    return [];
  }
  return [
    ...recordEventTypes(record).map(({ type, description, group }) => ({
      type,
      webhook: { description, group },
    })),
    ...(takes(record, 'comments')
      ? [
          {
            // Someone else commented on one they watch (platform/comments): bundled daily by default.
            // Typed against i18n/en/notifications.json's keys: `pnpm feature:sync` writes
            // this one, and the catalogs' test fails without it.
            type: `${recordKey(record)}.commented` as NotificationType,
            notification: {
              channels: { email: 'daily', webhook: true },
              data: commentedData,
            },
          } satisfies DomainEventDeclaration,
        ]
      : []),
  ];
};

/** The settings a record declares, and the flags that switch its approvals on. */
const recordSettingList = (record: RecordDeclaration) => [
  ...Object.values(recordSettings(record)),
  ...recordApprovalActions(record).flatMap((a) => (a.flag ? [a.flag] : [])),
];

/** A feature's declaration, typed (`<x>.feature.ts`). */
export const defineFeature = (feature: FeatureDefinition) => feature;

/** A feature's domain events (declared, and its record's), split by channel. */
const domainEvents = (feature: FeatureDefinition) =>
  expandDomainEvents([
    ...(feature.events ?? []),
    ...recordDomainEvents(feature.record),
  ]);

/** Every feature's declarations, merged in the features' order, for the groups' `forRoot()`. */
export function featureDeclarations(features: readonly FeatureDefinition[]) {
  const all = <T>(
    pick: (feature: FeatureDefinition) => readonly T[] | undefined,
  ) => features.flatMap((feature) => [...(pick(feature) ?? [])]);
  return {
    modules: features.map((feature) => feature.module),
    permissions: features.map((feature) => feature.permissions),
    resources: all((feature) => feature.resources),
    // Plus the domain events' webhook types (a record's `events` are among them).
    eventTypes: all((feature) => [
      ...(feature.eventTypes ?? []),
      ...domainEvents(feature).eventTypes,
    ]),
    incomingWebhooks: all((feature) => feature.incomingWebhooks),
    queues: all((feature) => feature.queues),
    customFields: all((feature) => [
      ...(feature.customFields ?? []),
      // A record that takes custom fields declares them itself (platform/records).
      ...recordCustomFields(feature.record),
    ]),
    notifications: all((feature) => [
      ...(feature.notifications ?? []),
      ...domainEvents(feature).notifications,
    ]),
    // Plus a record's `settings` and the flags of its approvals (platform/records).
    settings: all((feature) => [
      ...(feature.settings ?? []),
      ...(feature.record ? recordSettingList(feature.record) : []),
    ]),
    realtimeEvents: Object.assign(
      {},
      ...features.flatMap((feature) => [
        feature.realtimeEvents ?? {},
        domainEvents(feature).realtimeEvents,
      ]),
    ) as NonNullable<PlatformOptions['realtimeEvents']>,
    approvals: all((feature) => [
      ...(feature.approvals ?? []),
      ...(feature.record
        ? recordApprovalActions(feature.record).map((a) => a.declaration)
        : []),
    ]),
  };
}
