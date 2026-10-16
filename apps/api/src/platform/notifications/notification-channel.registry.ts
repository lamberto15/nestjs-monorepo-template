import { Injectable } from '@nestjs/common';
import type { NotificationChannel } from './notification.types.js';

/**
 * The channels notifications can go through, by name: the platform's
 * (realtime, email, webhook) and any a feature registers from its
 * constructor (`registry.register(this)`).
 */
@Injectable()
export class NotificationChannelRegistry {
  private readonly channels = new Map<string, NotificationChannel>();

  register(channel: NotificationChannel<any>) {
    if (this.channels.has(channel.name)) {
      throw new Error(`Two notification channels are named "${channel.name}".`);
    }
    this.channels.set(channel.name, channel);
  }

  get(name: string) {
    return this.channels.get(name);
  }

  all() {
    return [...this.channels.values()];
  }
}
