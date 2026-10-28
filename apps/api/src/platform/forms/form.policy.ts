import { Policy } from '@nestjs/authorization';
import { AccessService } from '../../iam/access/access.service.js';
import type { SubjectDefinition } from '../../iam/access/permissions.js';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * Runtime forms' subject (listed in PLATFORM_PERMISSIONS, ops.policy.ts):
 * four separate rights, none implying another. `edit`, not `manage`: CASL
 * reads `manage` as every action, submissions' answers included.
 */
export const FORM_SUBJECT: SubjectDefinition = {
  label: 'Forms',
  names: { singular: 'Form', plural: 'Forms' },
  conditions: {},
  actions: {
    read: {
      label: 'See published forms and their versions',
      conditions: [],
    },
    submit: {
      label: 'Fill in published forms, and see their own submissions',
      conditions: [],
    },
    edit: {
      label: 'Create forms, edit their drafts, publish and archive them',
      conditions: [],
    },
    readResponses: {
      label: "See everyone's submissions and their answers",
      conditions: [],
    },
  },
};

/** Who does what with forms (platform/forms). Answers are a person's: never through break-glass. */
@Policy()
export class FormPolicy {
  constructor(private readonly access: AccessService) {}

  read(user: Principal | null) {
    return this.access.can(user, 'read', 'Form');
  }

  submit(user: Principal | null) {
    return this.access.can(user, 'submit', 'Form');
  }

  edit(user: Principal | null) {
    return this.access.can(user, 'edit', 'Form');
  }

  async readResponses(user: Principal | null) {
    return (
      !user?.breakGlass && this.access.can(user, 'readResponses', 'Form')
    );
  }
}
