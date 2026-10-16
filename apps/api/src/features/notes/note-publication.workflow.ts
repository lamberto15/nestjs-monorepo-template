import {
  Workflow,
  type Duration,
  type WorkflowContext,
  type WorkflowRunner,
} from '@nestjs/workflows';
import { SystemContext } from '../../iam/access/system-context.js';
import { SettingsService } from '../../platform/settings/settings.service.js';
import { publishNow } from './note-events.js';
import { NOTE_PUBLICATION_JOB } from './note.policy.js';
import { NotePublisher } from './note-publisher.service.js';
import { NOTE_PUBLISH_DELAY } from './note-settings.js';

/** One publication per note: the note id is the workflow instance id. */
export const publicationId = (noteId: string) => `note-${noteId}`;

/**
 * The example durable workflow: wait for the delay or a "publish now" signal,
 * whichever comes first, then publish. It survives restarts and deploys: the
 * timer and the signal are in the database, and each step runs once.
 * Its steps act as the system principal (`system:note-publication`).
 */
@Workflow('note-publication', { timeout: '30d' })
export class NotePublicationWorkflow implements WorkflowRunner<
  string,
  { published: boolean; trigger: string }
> {
  constructor(
    private readonly publisher: NotePublisher,
    private readonly settings: SettingsService,
    private readonly system: SystemContext,
  ) {}

  async run(ctx: WorkflowContext, noteId: string) {
    ctx.setStatus('waiting');
    // The delay is a setting (changed at runtime, PUT /settings/notes.publishDelay);
    // read in a step, so a replay sees the value this instance started with.
    const delay = await ctx.step('delay', () =>
      this.settings.get(NOTE_PUBLISH_DELAY),
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
        { transaction: false },
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
        { transaction: false },
      ),
    );
    ctx.setStatus(published ? 'published' : 'gone');
    return { published, trigger: trigger.key };
  }
}
