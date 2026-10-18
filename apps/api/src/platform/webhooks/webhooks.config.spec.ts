import { NOTIFICATION_WEBHOOK_EVENT } from '../notifications/notification.types.js';
import {
  declaredEventTypes,
  eventTypeGroups,
  TEST_EVENT_TYPE,
  webhooksOptions,
} from './webhooks.config.js';

describe('webhook event types', () => {
  const options = {
    eventTypes: [
      'note.published',
      { type: 'note.created', description: 'A note was created.' },
      { type: 'invoice.paid', description: 'Paid.', group: 'billing' },
      'note.published', // twice: kept once, first declaration wins
    ],
  };

  it("declares the features' types, then the platform's, each once", () => {
    const types = declaredEventTypes(options).map(({ type }) => type);
    expect(types.slice(0, 3)).toEqual([
      'note.published',
      'note.created',
      'invoice.paid',
    ]);
    expect(types).toContain(NOTIFICATION_WEBHOOK_EVENT);
    expect(types).toContain('approval.requested');
    expect(types).not.toContain(TEST_EVENT_TYPE);
    expect(new Set(types).size).toBe(types.length);
  });

  it('groups them by their first segment unless a group is declared', () => {
    const groups = eventTypeGroups(options);
    expect(groups[0]).toEqual({
      group: 'note',
      types: [
        { type: 'note.published', description: null },
        { type: 'note.created', description: 'A note was created.' },
      ],
    });
    expect(groups[1]).toEqual({
      group: 'billing',
      types: [{ type: 'invoice.paid', description: 'Paid.' }],
    });
    expect(groups.map((g) => g.group)).toContain('approval');
  });

  it('gives the package the same types, as strings', () => {
    expect(webhooksOptions(options, {}).eventTypes).toEqual(
      declaredEventTypes(options).map(({ type }) => type),
    );
  });
});
