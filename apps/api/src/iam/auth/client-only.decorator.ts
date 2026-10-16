import { applyDecorators } from '@nestjs/common';
import { Authenticate, CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { ApiKeyAuth } from './api-key-auth.provider.js';
import type { ClientPrincipal } from './principal.js';

export type Client = ClientPrincipal;

/**
 * Routes for API clients only: only an API key signs in here (a users
 * session counts as no credentials), and every route scopes what it reads or
 * changes to the client, as the tenant.
 */
export const ClientOnly = () =>
  applyDecorators(Authenticate({ providers: [ApiKeyAuth] }), Can.Anyone());

/** The API client whose key signed the request. */
export const CurrentClient = CurrentUser;
