import { applyDecorators } from '@nestjs/common';
import { Authenticate, type AuthenticateOptions } from '@nestjs/authentication';
import { JwtAuth } from './jwt-auth.provider.js';
import { SessionAuth } from './session-auth.provider.js';

/**
 * Routes for users only: a session cookie (browsers) or an access token
 * (mobile apps). An API key counts as no credentials here.
 */
export const UserOnly = (
  options: Omit<AuthenticateOptions, 'providers'> = {},
) =>
  applyDecorators(
    Authenticate({ ...options, providers: [SessionAuth, JwtAuth] }),
  );

/** Routes for browsers only (they set or read the session cookie). */
export const SessionOnly = (
  options: Omit<AuthenticateOptions, 'providers'> = {},
) => applyDecorators(Authenticate({ ...options, providers: [SessionAuth] }));
