import { CAPABILITIES } from '../records/record.js';
import { listCapabilities } from './list-capabilities.js';

const ON = { documents: true, webhooks: true, approvals: false };

describe('listCapabilities', () => {
  it('answers every capability record.ts declares, true for those the subject takes', () => {
    const capabilities = listCapabilities(['comments', 'tags', 'watch'], ON);
    expect(Object.keys(capabilities).sort()).toEqual(
      [...CAPABILITIES, 'approvals'].sort(),
    );
    expect(
      Object.entries(capabilities)
        .filter(([, on]) => on)
        .map(([name]) => name)
        .sort(),
    ).toEqual(['comments', 'tags', 'watch']);
  });

  it('turns off what a deployment switch leaves out: pdf without Gotenberg, events without WEBHOOKS', () => {
    expect(
      listCapabilities(['pdf', 'attachments', 'events'], ON),
    ).toMatchObject({ pdf: true, attachments: true, events: true });
    expect(
      listCapabilities(['pdf', 'attachments', 'events'], {
        ...ON,
        documents: false,
        webhooks: false,
      }),
    ).toMatchObject({ pdf: false, attachments: true, events: false });
  });

  it('never turns on what is not declared, whatever the switches', () => {
    expect(listCapabilities([], ON)).toMatchObject({
      pdf: false,
      events: false,
      comments: false,
    });
  });

  it('says approvals when an approvable action of the subject is declared', () => {
    expect(listCapabilities([], { ...ON, approvals: true }).approvals).toBe(
      true,
    );
    expect(listCapabilities(['comments'], ON).approvals).toBe(false);
  });
});
