import {
  Workflow,
  type Duration,
  type WorkflowContext,
  type WorkflowRunner,
} from '@nestjs/workflows';
import { inTenantOf } from '../../core/tenancy/tenant-job.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { SettingsService } from '../../platform/settings/settings.service.js';
import { type NotePublicationInput, publishNow } from './note-events.js';
import { NOTE_PUBLICATION_JOB } from './note.policy.js';
import { NotePublisher } from './note-publisher.service.js';
import { NOTE_PUBLISH_DELAY } from './note-settings.js';

/** One publication per note: the note id is the workflow instance id. */
export const publicationId = (noteId: string) => `note-${noteId}`;

/**
 * The example durable workflow: wait for the delay or a "publish now" signal,
 * whichever comes first, then publish. It survives restarts and deploys: the
 * timer and the signal are in the database, and each step runs once.
 * Its steps act as the system principal (`system:note-publication`), in
 * the note's tenant (the input's `tenantId`, docs/tenancy.md).
 */
@Workflow('note-publication', { timeout: '30d' })
export class NotePublicationWorkflow implements WorkflowRunner<
  NotePublicationInput,
  { published: boolean; trigger: string }
> {
  constructor(
    private readonly publisher: NotePublisher,
    private readonly settings: SettingsService,
    private readonly system: SystemContext,
  ) {}

  async run(ctx: WorkflowContext, input: NotePublicationInput) {
    const { noteId, tenantId } = input;
    ctx.setStatus('waiting');
    // The delay is a setting (changed at runtime, PUT /settings/notes.publishDelay);
    // read in a step, so a replay sees the value this instance started with.
    // The tenant's value: the step runs in the note's tenant.
    const delay = await ctx.step('delay', () =>
      inTenantOf(input, () => this.settings.get(NOTE_PUBLISH_DELAY)),
    );
    const trigger = await ctx.waitForAny('await-publication', {
      delay: ctx.timer(delay as Duration),
      now: ctx.signalWait(publishNow, { key: noteId }),
    });
    // With notes.publishApproval on, an editor approves first (note-approvals.ts):
    // the approval's workflow publishes it then. The step's key makes a retry
    // find the request it made instead of making another.
    const approval = await ctx.step('request-approval', ({ idempotencyKey }) =>
      this.system.run(
        NOTE_PUBLICATION_JOB,
        () => this.publisher.requestApproval(noteId, idempotencyKey),
        { transaction: false, tenantId },
      ),
    );
    if (approval !== 'not-needed') {
      ctx.setStatus(approval === 'requested' ? 'awaiting-approval' : approval);
      return { published: false, trigger: trigger.key };
    }
    const published = await ctx.step('publish', () =>
      this.system.run(
        NOTE_PUBLICATION_JOB,
        (system) => this.publisher.publish(noteId, system),
        { transaction: false, tenantId },
      ),
    );
    ctx.setStatus(published ? 'published' : 'gone');
    return { published, trigger: trigger.key };
  }
}
