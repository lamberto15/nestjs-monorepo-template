import type { Type } from '@nestjs/common';

/**
 * Deployment switches (docs/configuration.md, "Deployment switches"): whole
 * platform modules a project may not need. Each is `on` unless the
 * environment says `off`, so nothing changes until it is turned off. Read
 * from `process.env` when the module graph is built (the routes and
 * providers a switch leaves out are decided then, as with OUTBOX_RELAY);
 * the values are still validated at boot (platform.env.ts), so a typo stops
 * the app instead of reading as on.
 */
export type PlatformSwitch = 'WEBHOOKS' | 'REPORTS' | 'USAGE' | 'REALTIME';

export const switchedOn = (name: PlatformSwitch) =>
  process.env[name]?.toLowerCase() !== 'off';

/** `items` when the switch is on, else nothing: spreads into controller and provider lists. */
export const whenOn = <T = Type>(
  name: PlatformSwitch,
  ...items: NoInfer<T>[]
): T[] => (switchedOn(name) ? items : []);
