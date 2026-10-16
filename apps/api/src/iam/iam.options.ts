import type { ResourceDefinition } from './resources/resource.js';
import type { PermissionsDefinition } from './access/permissions.js';

export const IAM_OPTIONS = Symbol('IAM_OPTIONS');

export interface IamOptions {
  /** The permissions every other group and feature declares (`definePermissions()`). */
  permissions: PermissionsDefinition[];
  /** The resources whose declarations the platform acts on (soft delete). */
  resources?: ResourceDefinition[];
}
