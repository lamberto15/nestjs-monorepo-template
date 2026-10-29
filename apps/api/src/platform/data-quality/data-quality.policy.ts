import { Policy } from '@nestjs/authorization';
import { AccessService } from '../../iam/access/access.service.js';
import type { SubjectDefinition } from '../../iam/access/permissions.js';
import type { Principal } from '../../iam/auth/principal.js';

/** The data-quality checks' subject (listed in PLATFORM_PERMISSIONS, ops.policy.ts). */
export const DATA_QUALITY_SUBJECT: SubjectDefinition = {
  label: 'Data quality',
  conditions: {},
  actions: {
    read: {
      label:
        'See the data-quality findings on the records and fields you may read',
      conditions: [],
    },
    manage: {
      label: 'Start a data-quality scan, dismiss and recheck findings',
      conditions: [],
    },
  },
};

/** The data-quality dashboard (platform/data-quality): who reads it and acts on it. */
@Policy()
export class DataQualityPolicy {
  constructor(private readonly access: AccessService) {}

  async read(user: Principal | null) {
    return this.access.can(user, 'read', 'DataQuality');
  }

  async manage(user: Principal | null) {
    return this.access.can(user, 'manage', 'DataQuality');
  }
}
