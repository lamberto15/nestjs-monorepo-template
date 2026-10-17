import { Injectable } from '@nestjs/common';
import type { Realtime } from './realtime.service.js';

/**
 * `Realtime` when REALTIME=off: no gateway, no socket.io adapter, and every
 * push does nothing. The features that push (notifications, bulk and data
 * transfer progress, documents, approvals) keep working: what they store
 * and mail is unchanged, only the live event is not sent.
 */
@Injectable()
export class NoRealtime implements Pick<Realtime, 'toPrincipal' | 'toRoom'> {
  toPrincipal() {
    // Nobody is connected.
  }

  toRoom() {
    // Nobody is connected.
  }
}
