import type { ConfigService } from '@nestjs/config';
import type { PlatformEnv } from '../platform.env.js';

/**
 * The types a picture may be, recognized from the file's bytes (never the
 * client's word or the name): the formats every browser shows in an
 * `<img>`. Not SVG (it scripts), not HEIC/AVIF (not shown everywhere).
 */
export const AVATAR_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/** What a picture may be: its largest size and its types (AVATAR_MAX_MB). */
export interface AvatarLimits {
  /** The largest file, in bytes: a larger one is a 413. */
  maxBytes: number;
  maxMb: number;
  types: readonly string[];
}

export function avatarLimits(
  config: ConfigService<PlatformEnv, true>,
): AvatarLimits {
  const maxMb = config.get('AVATAR_MAX_MB', { infer: true });
  return { maxBytes: maxMb * 1024 * 1024, maxMb, types: AVATAR_TYPES };
}
