import { Resolver } from 'node:dns/promises';
import { BullModule } from '@nestjs/bullmq';
import { OidcSso } from './oidc-sso.service.js';
import { SamlMetadataImport } from './saml-metadata.service.js';
import { SamlSso } from './saml-sso.service.js';
import { ScimController } from './scim/scim.controller.js';
import { ScimGroupsService } from './scim/scim-groups.service.js';
import { ScimUsersService } from './scim/scim-users.service.js';
import { SsoAccounts } from './sso-accounts.service.js';
import {
  SsoAuthController,
  SsoConnectionGuard,
} from './sso-auth.controller.js';
import { SsoConnectionsService } from './sso-connections.service.js';
import { SsoDiscoveryController } from './sso-discovery.controller.js';
import { SsoDiscovery } from './sso-discovery.service.js';
import { SsoDomainsService } from './sso-domains.service.js';
import { SsoPolicyService } from './sso-policy.service.js';
import { SsoController } from './sso.controller.js';
import { SsoProcessor } from './sso.processor.js';
import { SSO_QUEUE, SSO_TXT_RESOLVER } from './sso.queue.js';

/**
 * Enterprise SSO and SCIM (docs/auth.md, "Enterprise SSO"): what IamModule
 * registers, here so the module's list stays readable. In IamModule
 * itself, not a module of their own: they sign in through
 * @nestjs/authentication's SignInService, which only IamModule imports.
 */
export const ssoImports = [BullModule.registerQueue({ name: SSO_QUEUE })];

export const ssoControllers = [
  SsoController,
  SsoDiscoveryController,
  SsoAuthController,
  ScimController,
];

export const ssoProviders = [
  SsoConnectionsService,
  SsoDomainsService,
  SsoPolicyService,
  SsoDiscovery,
  SsoAccounts,
  OidcSso,
  SamlSso,
  SamlMetadataImport,
  SsoConnectionGuard,
  SsoProcessor,
  ScimUsersService,
  ScimGroupsService,
  // The domains' TXT lookups: the system resolver, bounded; the tests replace it.
  {
    provide: SSO_TXT_RESOLVER,
    useFactory: () => new Resolver({ timeout: 5000, tries: 2 }),
  },
];
