import { z } from 'zod';
import { defineDomainEvents, expandDomainEvents } from './domain-event.js';

describe('expandDomainEvents', () => {
  it('splits an event by channel, in declaration order', () => {
    const events = defineDomainEvents([
      { type: 'x.created', webhook: true },
      {
        type: 'note.published',
        webhook: { description: 'Published.', group: 'note' },
        notification: {
          channels: { email: 'immediate' },
          data: z.object({ noteId: z.string() }),
        },
        realtime: {
          id: 'RealtimeNotePublishedEvent',
          description: 'A note was published.',
          payload: z.object({ noteId: z.string() }),
        },
      },
    ]);
    const { eventTypes, notifications, realtimeEvents } =
      expandDomainEvents(events);

    expect(eventTypes).toEqual([
      { type: 'x.created' },
      { type: 'note.published', description: 'Published.', group: 'note' },
    ]);
    expect(notifications.map((n) => n.type)).toEqual(['note.published']);
    expect(Object.keys(realtimeEvents)).toEqual(['note.published']);
    expect(realtimeEvents['note.published']!.payload.meta()?.id).toBe(
      'RealtimeNotePublishedEvent',
    );
  });

  it('refuses a realtime event declared twice', () => {
    const realtime = {
      id: 'R',
      description: 'r',
      payload: z.object({}),
    };
    expect(() =>
      expandDomainEvents([
        { type: 'a.b', realtime },
        { type: 'a.b', realtime },
      ]),
    ).toThrow(/declared twice/);
  });
});
