import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearEditorDraftsForIdentity,
  discardEditorDraft,
  EDITOR_DRAFT_LIMIT,
  EDITOR_DRAFT_TTL,
  readEditorDraft,
  saveEditorDraft,
} from './editor-drafts';

const at = 1_800_000_000_000;
const draft = (
  identity: string,
  tenantId: string,
  recordId: string,
  value = 'text',
) => ({ identity, tenantId, recordId, value });

describe('identity-scoped editor drafts', () => {
  beforeEach(() => localStorage.clear());

  it('preserves a draft across reload and only returns it to the matching identity, tenant and record', () => {
    saveEditorDraft(draft('user-a|tenant-a|', 'tenant-a', 'record-a'), at);

    expect(
      readEditorDraft('user-a|tenant-a|', 'tenant-a', 'record-a', at)?.value,
    ).toBe('text');
    expect(
      readEditorDraft('user-b|tenant-a|', 'tenant-a', 'record-a', at),
    ).toBeUndefined();
    expect(
      readEditorDraft('user-a|tenant-b|', 'tenant-b', 'record-a', at),
    ).toBeUndefined();
    expect(
      readEditorDraft('user-a|tenant-a|', 'tenant-a', 'record-b', at),
    ).toBeUndefined();
  });

  it('expires old data and bounds retained entries to the newest 50', () => {
    saveEditorDraft(
      draft('user', 'tenant', 'expired'),
      at - EDITOR_DRAFT_TTL - 1,
    );
    expect(readEditorDraft('user', 'tenant', 'expired', at)).toBeUndefined();

    for (let index = 0; index < EDITOR_DRAFT_LIMIT + 1; index++) {
      saveEditorDraft(draft('user', 'tenant', `record-${index}`), at + index);
    }
    expect(
      readEditorDraft(
        'user',
        'tenant',
        'record-0',
        at + EDITOR_DRAFT_LIMIT + 1,
      ),
    ).toBeUndefined();
    expect(
      readEditorDraft(
        'user',
        'tenant',
        'record-50',
        at + EDITOR_DRAFT_LIMIT + 1,
      ),
    ).toBeDefined();
  });

  it('discards only the selected identity, tenant and record entry', () => {
    saveEditorDraft(draft('user-a', 'tenant-a', 'record-a'), at);
    saveEditorDraft(draft('user-b', 'tenant-a', 'record-a'), at + 1);
    discardEditorDraft('user-a', 'tenant-a', 'record-a', at + 2);
    expect(
      readEditorDraft('user-a', 'tenant-a', 'record-a', at + 2),
    ).toBeUndefined();
    expect(
      readEditorDraft('user-b', 'tenant-a', 'record-a', at + 2),
    ).toBeDefined();
  });

  it('clears only the confirmed signed-out identity drafts', () => {
    saveEditorDraft(draft('user-a|tenant-a|', 'tenant-a', 'record-a'), at);
    saveEditorDraft(draft('user-a|tenant-b|', 'tenant-b', 'record-b'), at + 1);
    saveEditorDraft(draft('user-b|tenant-a|', 'tenant-a', 'record-a'), at + 2);
    clearEditorDraftsForIdentity('user-a|tenant-a|', at + 3);

    expect(
      readEditorDraft('user-a|tenant-a|', 'tenant-a', 'record-a', at + 3),
    ).toBeUndefined();
    expect(
      readEditorDraft('user-a|tenant-b|', 'tenant-b', 'record-b', at + 3),
    ).toBeDefined();
    expect(
      readEditorDraft('user-b|tenant-a|', 'tenant-a', 'record-a', at + 3),
    ).toBeDefined();
  });
});
