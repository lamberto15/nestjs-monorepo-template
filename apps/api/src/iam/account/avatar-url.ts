import { basename } from 'node:path';

/**
 * The address of a user's picture (`avatarUrl`): a stable path the web app
 * puts in an `<img>`, never a signed link (those expire within minutes).
 * `GET /v1/people/{id}/avatar` answers it with the file itself (from the
 * API's origin, so an `<img>` loads it wherever the page is served). The
 * `v` is the stored file's name (a new random one at every upload), so a
 * new picture is a new address and the browser's cached one is not shown
 * again. Null when the user has no picture.
 */
export function avatarUrl(
  userId: string,
  avatarKey: string | null,
): string | null {
  if (!avatarKey) {
    return null;
  }
  const version = basename(avatarKey).replace(/\.[a-z0-9]+$/i, '');
  return `/v1/people/${userId}/avatar?v=${encodeURIComponent(version)}`;
}
