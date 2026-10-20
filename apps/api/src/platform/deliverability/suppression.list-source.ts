import { Injectable } from '@nestjs/common';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { actsAsOperator } from '../../iam/auth/operator-only.js';
import { ListsRegistry } from '../lists/lists.registry.js';
import { MAIL_SUPPRESSION_LIST } from './suppression.list.js';
import { MailSuppressionPolicy } from './suppression.policy.js';

/**
 * The suppression list (GET /v1/mail/suppressions), described as records'
 * lists are (GET /v1/lists/MailSuppression), to whoever may call that route:
 * a principal acting in the operator tenant (`@OperatorOnly()`) holding
 * `MailSuppression.view`; anyone else gets a 403 there too. Not a record: no
 * capabilities, no custom fields, no recycle bin.
 */
@Injectable()
export class MailSuppressionListSource {
  constructor(
    registry: ListsRegistry,
    policy: MailSuppressionPolicy,
    tenancy: Tenancy,
  ) {
    registry.register({
      subject: 'MailSuppression',
      list: MAIL_SUPPRESSION_LIST,
      capabilities: [],
      readable: async (principal) =>
        (await actsAsOperator(tenancy, principal)) &&
        (await policy.view(principal)),
    });
  }
}
