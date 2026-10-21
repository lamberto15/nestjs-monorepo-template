import { Injectable } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import {
  InMemoryMailTransport,
  LogMailTransport,
  ResendTransport,
} from '@nestjs/mail';
import { createObserveModule } from '@nestjs/observe';
import { describe, expect, it } from 'vitest';
import { skipObserve } from './observe.js';

// Runs the classes through Observe's real instance decorator, the one Nest
// applies to every provider when OBSERVE_APP_KEY is set (issue #392): a proxy
// around them broke the mail transports and every lock-decorated job.
const decorate = (instance: object) => {
  const { ObserveInstrument } = createObserveModule({
    skipInstrumentation: skipObserve,
  });
  return (
    ObserveInstrument as unknown as { instanceDecorator: (i: object) => object }
  ).instanceDecorator(instance);
};

@Injectable()
class LockedJob {
  @OnOneInstance({ ttl: '1m' })
  run() {
    return 'ran';
  }
}

@Injectable()
class OverlapJob {
  @WithoutOverlapping({ ttl: '1m' })
  run() {
    return 'ran';
  }
}

@Injectable()
class PlainService {
  run() {
    return 'ran';
  }
}

describe('Observe instrumentation exclusions', () => {
  it('leaves the mail transports unproxied', () => {
    for (const transport of [
      new ResendTransport({ apiKey: 're_test' }),
      new InMemoryMailTransport(),
      new LogMailTransport(),
    ]) {
      expect(decorate(transport)).toBe(transport);
    }
  });

  it('leaves every lock-decorated job unproxied, without a list', () => {
    for (const job of [new LockedJob(), new OverlapJob()]) {
      expect(decorate(job)).toBe(job);
    }
  });

  it('still instruments other providers (the exclusion is narrow)', () => {
    const service = new PlainService();
    expect(decorate(service)).not.toBe(service);
  });
});
