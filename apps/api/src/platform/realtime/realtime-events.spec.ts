import type { OpenAPIObject } from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';
import { addRealtimeEvents, REALTIME_EVENTS } from './realtime-events.js';

describe('addRealtimeEvents', () => {
  const document = { openapi: '3.0.0' } as OpenAPIObject;
  addRealtimeEvents(document);
  const manifest = (document as unknown as Record<string, any>)[
    'x-realtime-events'
  ];

  it('publishes every declared event with a payload component', () => {
    expect(Object.keys(manifest)).toEqual(Object.keys(REALTIME_EVENTS));
    for (const event of Object.values<any>(manifest)) {
      const id = event.payload.$ref.replace('#/components/schemas/', '');
      expect(document.components?.schemas?.[id]).toBeDefined();
      expect(event.description).not.toBe('');
    }
  });

  it('keeps the names the web app and API clients depend on', () => {
    expect(Object.keys(manifest)).toEqual(
      expect.arrayContaining([
        'notification',
        'data.progress',
        'data.failed',
        'bulk.progress',
        'bulk.failed',
        'approval.applied',
        'record.attachments.changed',
      ]),
    );
  });
});
