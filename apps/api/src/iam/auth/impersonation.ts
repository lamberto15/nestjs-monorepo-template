import type { MfaState, SessionRecord } from '@nestjs/authentication';
import type { AuthenticationMetadata } from './authentication-method.js';

/** What an impersonation session records about the administrator behind it. */
export interface Impersonation {
  id: string;
  email: string;
  /** Their own session's second factor, restored when they stop. */
  mfa: MfaState | null;
  /**
   * How and when they signed in, restored when they stop. Kept here, not in
   * the session's own keys: an impersonation is nobody's sign-in, and never
   * satisfies step-up (ReauthenticationService).
   */
  authentication?: AuthenticationMetadata;
  startedAt: string;
  endsAt: string;
}

/** The impersonation a session carries, if it is one. */
export const impersonationOf = (session: SessionRecord | undefined) =>
  session?.metadata?.impersonator as Impersonation | undefined;
