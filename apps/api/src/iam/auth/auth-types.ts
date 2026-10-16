import type { RequestPrincipal } from './principal.js';

declare module '@nestjs/authentication' {
  interface AuthenticationTypes {
    /** Never the system principal: PrincipalGuard refuses it. */
    user: RequestPrincipal;
  }
}
