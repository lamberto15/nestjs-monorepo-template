import { Injectable } from '@nestjs/common';
import { AccessPolicy } from '../../iam/access/policies.js';
import { ListsRegistry } from '../lists/lists.registry.js';
import { DELIVERY_LIST } from './webhook-store.view.js';

/**
 * The delivery log, described as the records' lists are
 * (GET /v1/lists/WebhookDelivery): `DELIVERY_LIST`'s filters, sort and fields,
 * the declaration both delivery list routes validate with
 * (`GET /v1/webhook-deliveries`, `GET /v1/access/clients/{clientId}/webhook-deliveries`).
 * The description is of the list, not of one client's: the client stays in
 * the path (or is the caller, with an API key).
 *
 * Custom: a delivery is not a record, and no permission names it (no CASL
 * subject to `read`), so the registration's `readable` replaces the
 * subject's `read` check (ListPolicy), as the access API's lists do
 * (access-lists.ts). It says who may call a delivery list route: an API
 * client (its own log, no permission needed) and a user who manages
 * clients (`Access.manageClients`, the delegated routes). No capabilities,
 * custom fields or recycle bin. Registered with the routes only while
 * WEBHOOKS is on (the routes and this are 404 otherwise).
 */
@Injectable()
export class WebhookListSource {
  constructor(registry: ListsRegistry, policy: AccessPolicy) {
    registry.register({
      subject: 'WebhookDelivery',
      list: DELIVERY_LIST,
      capabilities: [],
      readable: async (principal) =>
        principal?.kind === 'client' || (await policy.manageClients(principal)),
    });
  }
}
