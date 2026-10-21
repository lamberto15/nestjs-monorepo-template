import type { DevicePlatform } from '../messaging.tables.js';
import type { PushPayload, PushProvider } from './push-provider.js';

/**
 * Several push providers behind the one interface (`PUSH_PROVIDER=web-push,apns,fcm`):
 * a send goes to the provider that serves the device's platform.
 */
export class CompositePushProvider implements PushProvider {
  readonly name: string;
  readonly platforms: readonly DevicePlatform[];

  constructor(private readonly providers: readonly PushProvider[]) {
    this.name = providers.map((provider) => provider.name).join(',');
    this.platforms = [
      ...new Set(providers.flatMap((provider) => provider.platforms)),
    ];
  }

  async send(token: string, payload: PushPayload, platform?: DevicePlatform) {
    const provider = this.providers.find(
      (candidate) => platform && candidate.platforms.includes(platform),
    );
    // The processor only sends to a platform this serves; none is a device with no provider.
    return provider ? provider.send(token, payload, platform) : 'gone';
  }
}
