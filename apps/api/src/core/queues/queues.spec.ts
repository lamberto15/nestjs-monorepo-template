import { applyQueueConcurrency, queueConcurrencyVariable } from './queues.js';

const worker = (name: string, concurrency: number) => ({ name, concurrency });

describe('applyQueueConcurrency', () => {
  it('sets a worker from the variable named after its queue', () => {
    const data = worker('data-transfers', 2);
    const mail = worker('mail', 5);
    const values: Record<string, unknown> = {
      QUEUE_CONCURRENCY_DATA_TRANSFERS: 1,
      QUEUE_CONCURRENCY_MAIL: 8,
    };
    applyQueueConcurrency([data, mail], (key) => values[key]);
    expect(data.concurrency).toBe(1);
    expect(mail.concurrency).toBe(8);
  });

  it('keeps the processor value of a queue without a variable', () => {
    const other = worker('thumbnails', 3);
    applyQueueConcurrency([other], () => undefined);
    expect(other.concurrency).toBe(3);
  });

  it('names the variable after the queue', () => {
    expect(queueConcurrencyVariable('attachment-scan')).toBe(
      'QUEUE_CONCURRENCY_ATTACHMENT_SCAN',
    );
  });
});
