import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Mailer } from '@nestjs/mail';
import { DEFAULT_MAIL_BRAND, type MailBranding } from './mail-branding.js';
import type { MailDeliveryGate } from './mail-delivery.js';
import { MailQueue } from './mail-queue.js';

class Hello {}

describe('MailQueue', () => {
  const rendered = {
    from: { address: 'noreply@example.com', name: 'My API' },
    replyTo: [],
    to: [{ address: 'a@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Hello',
    html: '<p>Hi</p>',
    text: 'Hi',
    headers: {},
    attachments: [],
  };

  function queueWith(branding?: MailBranding) {
    const add = vi.fn(async () => undefined);
    const render = vi.fn(async () => rendered);
    const admit = vi.fn(async () => true);
    const queue = new MailQueue(
      { add } as unknown as Queue,
      { render } as unknown as Mailer,
      { admit } as unknown as MailDeliveryGate,
      branding,
    );
    return { queue, add, render, admit };
  }

  afterEach(() => vi.restoreAllMocks());

  it('signs the mail with the tenant’s sender name', async () => {
    const { queue, add } = queueWith({
      current: async () => ({ ...DEFAULT_MAIL_BRAND, name: 'Acme' }),
    });
    await queue.send(Hello, { to: 'a@example.com' } as never);
    expect(add).toHaveBeenCalledWith(
      'Hello',
      expect.objectContaining({
        from: { address: 'noreply@example.com', name: 'Acme' },
      }),
      expect.anything(),
    );
  });

  it('queues the mail unbranded when the brand can’t be read, and says so', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { queue, add, render } = queueWith({
      current: async () => {
        throw new Error('object store down');
      },
    });
    await queue.send(Hello, { to: 'a@example.com' } as never);
    expect(render).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      'Hello',
      expect.objectContaining({ from: rendered.from }),
      expect.anything(),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unbranded'),
      expect.objectContaining({ error: 'object store down' }),
    );
  });

  it('neither renders nor queues a mail the gate withholds', async () => {
    const { queue, add, render, admit } = queueWith();
    admit.mockResolvedValue(false);
    await queue.send(Hello, { to: 'a@example.com' } as never);
    expect(admit).toHaveBeenCalledWith(Hello, { essential: false });
    expect(render).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('names the tenant on the job, and marks a mail sent as essential', async () => {
    const { queue, add } = queueWith();
    await queue.send(Hello, { to: 'a@example.com' } as never, {
      essential: true,
    });
    expect(add).toHaveBeenCalledWith(
      'Hello',
      expect.objectContaining({ tenantId: null, mandatory: true }),
      expect.anything(),
    );
  });

  it('stops waiting for Redis when the signal aborts', async () => {
    const { queue, add } = queueWith();
    add.mockImplementation(() => new Promise<undefined>(() => {}));
    const controller = new AbortController();
    const sending = queue.send(Hello, { to: 'a@example.com' } as never, {
      jobId: 'j1',
      signal: controller.signal,
    });
    const outcome = expect(sending).rejects.toThrow('timed out');
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    controller.abort(new Error('timed out'));
    await outcome;
  });

  it('adds nothing when the signal is already aborted', async () => {
    const { queue, add } = queueWith();
    const controller = new AbortController();
    controller.abort(new Error('timed out'));
    await expect(
      queue.send(Hello, { to: 'a@example.com' } as never, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('timed out');
    expect(add).not.toHaveBeenCalled();
  });
});
