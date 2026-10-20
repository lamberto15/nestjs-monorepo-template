import type { DevicePlatform } from '../messaging.tables.js';
import type { PushPayload, PushProvider } from './push-provider.js';

/** Keeps what it would send (tests, `PUSH_PROVIDER=memory`). A token starting `dead-` is reported gone. */
export class MemoryPushProvider implements PushProvider {
  readonly name = 'memory';
  readonly platforms: readonly DevicePlatform[] = ['web', 'ios', 'android'];
  readonly sent: { token: string; payload: PushPayload }[] = [];

  async send(token: string, payload: PushPayload) {
    if (token.startsWith('dead-')) {
      return 'gone' as const;
    }
    this.sent.push({ token, payload });
    return 'sent' as const;
  }
}
