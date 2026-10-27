import { Injectable } from '@nestjs/common';

/**
 * What else must end when a stored browser session is removed, or a token
 * client's refresh family is revoked (sign-out, a reused refresh token, a
 * re-authentication, signing out everywhere).
 */
export interface SessionLifecycleListener {
  readonly name: string;
  afterRevocation(sessionId: string): void | Promise<void>;
  /**
   * A token client's family was revoked: its `sid`, the claim every access
   * token of the family carries (`tokenClaims()`, authentication-method.ts).
   */
  afterTokenRevocation?(tokenSessionId: string): void | Promise<void>;
}

@Injectable()
export class SessionLifecycleRegistry {
  private readonly listeners = new Map<string, SessionLifecycleListener>();

  register(listener: SessionLifecycleListener) {
    if (this.listeners.has(listener.name)) {
      throw new Error(
        `Two session lifecycle listeners are named "${listener.name}".`,
      );
    }
    this.listeners.set(listener.name, listener);
  }

  async afterRevocation(sessionId: string) {
    await Promise.all(
      [...this.listeners.values()].map((listener) =>
        Promise.resolve(listener.afterRevocation(sessionId)),
      ),
    );
  }

  async afterTokenRevocation(tokenSessionId: string) {
    await Promise.all(
      [...this.listeners.values()].map((listener) =>
        Promise.resolve(listener.afterTokenRevocation?.(tokenSessionId)),
      ),
    );
  }
}
