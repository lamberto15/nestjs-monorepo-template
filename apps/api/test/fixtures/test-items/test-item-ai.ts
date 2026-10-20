import { Injectable, NotFoundException } from '@nestjs/common';
import { AccessService } from '../../../src/iam/access/access.service.js';
import type { RequestPrincipal } from '../../../src/iam/auth/principal.js';
import {
  type AiContent,
  AiRegistry,
  type AiSource,
} from '../../../src/platform/ai/ai.registry.js';
import { TestItemPolicy } from './test-item.policy.js';
import { TestItemsService } from './test-items.service.js';

/**
 * A test item for the AI helper (platform/ai): its title, code and, only when
 * the requester may read it (TestItem.body), its text. Whoever may read the
 * item may ask.
 */
@Injectable()
export class TestItemAi implements AiSource {
  readonly name = 'testItem';
  readonly subject = 'TestItem';

  constructor(
    private readonly items: TestItemsService,
    private readonly policy: TestItemPolicy,
    private readonly access: AccessService,
    registry: AiRegistry,
  ) {
    registry.register(this);
  }

  async canUse(principal: RequestPrincipal, id: string) {
    await this.read(principal, id); // 404 when it is not theirs to read
    return true;
  }

  async content(principal: RequestPrincipal, id: string): Promise<AiContent> {
    const item = await this.read(principal, id);
    // Field-level: what this principal may read of it, nothing more leaves.
    const shown = (await this.access.redact(
      principal,
      'read',
      'TestItem',
      item,
    )) as Partial<typeof item>;
    return {
      title: item.title,
      fields: {
        status: shown.code ?? null,
        ...('body' in shown ? { body: shown.body ?? null } : {}),
      },
    };
  }

  private async read(principal: RequestPrincipal, id: string) {
    const item = await this.items.findOne(id); // 404 when gone or in the recycle bin
    if (!(await this.policy.read(principal, item))) {
      throw new NotFoundException(`Test item ${id} not found.`);
    }
    return item;
  }
}
