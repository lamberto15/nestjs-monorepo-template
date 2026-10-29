import { publicationNotices } from './note-publisher.service.js';

const note = (n: number, ownerId = 'user:owner') => ({
  id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  title: `Note ${n}`,
  ownerId,
});

describe('publicationNotices', () => {
  it('tells the owner and the watchers of each note, one per note', () => {
    const rows = [note(1), note(2)];
    const notices = publicationNotices(
      rows,
      new Map([[rows[0]!.id, ['user:watcher', 'user:owner']]]),
    );
    expect(notices).toEqual([
      {
        type: 'note.published',
        to: ['user:owner', 'user:watcher'],
        data: { noteId: rows[0]!.id, title: 'Note 1' },
        link: `/notes/${rows[0]!.id}`,
      },
      {
        type: 'note.published',
        to: ['user:owner'],
        data: { noteId: rows[1]!.id, title: 'Note 2' },
        link: `/notes/${rows[1]!.id}`,
      },
    ]);
  });
});
