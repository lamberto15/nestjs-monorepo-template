/**
 * The account data exports this browser started, remembered in localStorage
 * per user: `GET /v1/data/transfers` never lists an account export (backend
 * issue #185). These helpers go once the API lists them; /transfers already
 * reads everything else from the API.
 */

export interface Started {
  id: string;
  kind: 'export' | 'import';
  name: string;
  at: string;
}

const HISTORY_KEY = 'account-exports';
const HISTORY_MAX = 30;

/**
 * The API has no list of a user's transfers (only `GET /v1/data/transfers/{id}`;
 * #136), so the ids this browser started are remembered here, per user.
 * `key` keeps another list apart (the account's own exports, which
 * `GET /v1/data/transfers` never lists: the privacy page).
 */
export function readHistory(userId: string, key = HISTORY_KEY): Started[] {
  try {
    const all = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<
      string,
      Started[]
    >;
    return Array.isArray(all[userId]) ? all[userId] : [];
  } catch {
    return [];
  }
}

function writeHistory(userId: string, items: Started[], key: string) {
  try {
    const all = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<
      string,
      Started[]
    >;
    all[userId] = items.slice(0, HISTORY_MAX);
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    // storage blocked: the page lists nothing, the jobs still run
  }
}

export function remember(userId: string, started: Started, key = HISTORY_KEY) {
  writeHistory(
    userId,
    [
      started,
      ...readHistory(userId, key).filter((item) => item.id !== started.id),
    ],
    key,
  );
}

export function forget(userId: string, id: string, key = HISTORY_KEY) {
  writeHistory(
    userId,
    readHistory(userId, key).filter((item) => item.id !== id),
    key,
  );
}
