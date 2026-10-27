import {
  BULK_PUBLICATION,
  publicationNotices,
} from './note-publisher.service.js';

const note = (n: number, ownerId = 'user:owner') => ({
  id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  title: `Note ${n}`,
  ownerId,
});

describe('publicationNotices', () => {
  it('tells the owner and the watchers of each note, up to the bulk threshold', () => {
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

  it('past the threshold, tells each person once, with how many of the notes are theirs (#618)', () => {
    const rows = Array.from({ length: BULK_PUBLICATION + 1 }, (_, i) =>
      note(i + 1, i === 0 ? 'user:other' : 'user:owner'),
    );
    const notices = publicationNotices(
      rows,
      new Map([
        [rows[0]!.id, ['user:watcher']],
        [rows[1]!.id, ['user:watcher', 'user:owner']],
      ]),
    );
    expect(notices).toEqual([
      {
        type: 'note.publishedMany',
        to: 'user:other',
        data: { notes: 1, title: 'Note 1' },
        link: '/notes',
      },
      {
        type: 'note.publishedMany',
        to: 'user:watcher',
        data: { notes: 2, title: 'Note 1' },
        link: '/notes',
      },
      {
        type: 'note.publishedMany',
        to: 'user:owner',
        data: { notes: BULK_PUBLICATION, title: 'Note 2' },
        link: '/notes',
      },
    ]);
  });
});
