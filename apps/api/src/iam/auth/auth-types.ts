import type { RequestPrincipal } from './principal.js';

declare module '@nestjs/authentication' {
  interface AuthenticationTypes {
    /** Never the system principal: PrincipalGuard refuses it. */
    user: RequestPrincipal;
    /**
     * What the session store reads along with a session (DrizzleAuthenticationStore):
     * its last activity as stored, before this request moved it, which the
     * tenant's idle timeout needs (SessionLifetime).
     */
    sessionExtra: { previousActiveAt: Date };
  }
}
