/** Local, identity-scoped editor drafts. Drafts are temporary recovery data, not a backup. */
export const EDITOR_DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
export const EDITOR_DRAFT_LIMIT = 50;
const STORAGE_KEY = 'app-editor-drafts-v1';

export type EditorDraft<T> = {
  identity: string;
  tenantId: string;
  recordId: string;
  value: T;
  updatedAt: number;
};

type DraftMap = Record<string, EditorDraft<unknown>>;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function read(now: number): DraftMap {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => isFreshDraft(value, now)),
    ) as DraftMap;
  } catch {
    return {};
  }
}

function isFreshDraft(
  value: unknown,
  now: number,
): value is EditorDraft<unknown> {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<EditorDraft<unknown>>;
  return (
    typeof draft.identity === 'string' &&
    typeof draft.tenantId === 'string' &&
    typeof draft.recordId === 'string' &&
    typeof draft.updatedAt === 'number' &&
    now - draft.updatedAt >= 0 &&
    now - draft.updatedAt <= EDITOR_DRAFT_TTL
  );
}

function key(identity: string, tenantId: string, recordId: string) {
  return JSON.stringify([identity, tenantId, recordId]);
}

function write(map: DraftMap) {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage can be disabled or full; editing must still work in memory.
  }
}

export function readEditorDraft<T>(
  identity: string,
  tenantId: string,
  recordId: string,
  now = Date.now(),
): EditorDraft<T> | undefined {
  const drafts = read(now);
  write(drafts); // Opportunistically remove expired and malformed entries.
  return drafts[key(identity, tenantId, recordId)] as
    EditorDraft<T> | undefined;
}

export function saveEditorDraft<T>(
  draft: Omit<EditorDraft<T>, 'updatedAt'>,
  now = Date.now(),
) {
  const drafts = read(now);
  const id = key(draft.identity, draft.tenantId, draft.recordId);
  drafts[id] = { ...draft, updatedAt: now };
  const ordered = Object.entries(drafts).sort(
    (a, b) => b[1].updatedAt - a[1].updatedAt,
  );
  write(Object.fromEntries(ordered.slice(0, EDITOR_DRAFT_LIMIT)));
}

export function discardEditorDraft(
  identity: string,
  tenantId: string,
  recordId: string,
  now = Date.now(),
) {
  const drafts = read(now);
  delete drafts[key(identity, tenantId, recordId)];
  write(drafts);
}

/** Clear only the active identity's drafts on explicit sign-out. */
export function clearEditorDraftsForIdentity(
  identity: string,
  now = Date.now(),
) {
  const drafts = read(now);
  write(
    Object.fromEntries(
      Object.entries(drafts).filter(([, draft]) => draft.identity !== identity),
    ),
  );
}
