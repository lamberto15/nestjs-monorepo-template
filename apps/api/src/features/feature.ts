import type { Type } from '@nestjs/common';
import type { PermissionsDefinition } from '../iam/access/permissions.js';
import type { ResourceDefinition } from '../iam/resources/resource.js';
import { commentedData } from '../platform/comments/comment-notifications.js';
import { defineNotifications } from '../platform/notifications/notification.types.js';
import type { PlatformOptions } from '../platform/platform.options.js';
import {
  type RecordDeclaration,
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
  /**
   * Its records' declaration (`<x>.record.ts`), when they are declared:
   * what their capabilities need of the platform is derived from it (the
   * `<item>.commented` notification with comments).
   */
  record?: RecordDeclaration;
}

/** The notifications a record's capabilities bring: `<item>.commented` with comments. */
const recordNotifications = (record: RecordDeclaration | undefined) =>
  record && takes(record, 'comments')
    ? defineNotifications([
        {
          // Someone else commented on one they watch (platform/comments): bundled daily by default.
          // Typed against i18n/en/notifications.json's keys: `pnpm feature:sync` writes
          // this one, and the catalogs' test fails without it.
          type: `${recordKey(record)}.commented` as never,
          channels: { email: 'daily', webhook: true },
          data: commentedData,
        },
      ])
    : [];

/** A feature's declaration, typed (`<x>.feature.ts`). */
export const defineFeature = (feature: FeatureDefinition) => feature;

/** Every feature's declarations, merged in the features' order, for the groups' `forRoot()`. */
export function featureDeclarations(features: readonly FeatureDefinition[]) {
  const all = <T>(
    pick: (feature: FeatureDefinition) => readonly T[] | undefined,
  ) => features.flatMap((feature) => [...(pick(feature) ?? [])]);
  return {
    modules: features.map((feature) => feature.module),
    permissions: features.map((feature) => feature.permissions),
    resources: all((feature) => feature.resources),
    eventTypes: all((feature) => feature.eventTypes),
    incomingWebhooks: all((feature) => feature.incomingWebhooks),
    queues: all((feature) => feature.queues),
    customFields: all((feature) => feature.customFields),
    notifications: all((feature) => [
      ...(feature.notifications ?? []),
      ...recordNotifications(feature.record),
    ]),
    settings: all((feature) => feature.settings),
    approvals: all((feature) => feature.approvals),
  };
}
