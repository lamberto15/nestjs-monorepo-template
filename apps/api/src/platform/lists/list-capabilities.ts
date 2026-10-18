import { CAPABILITIES, type Capability } from '../records/record.js';
import type { ListCapabilities } from './list-metadata.schemas.js';

/** The deployment switches a capability needs besides its declaration. */
export interface CapabilitySwitches {
  /** PDF documents are set up (`PdfRenderer.enabled`: GOTENBERG_URL). */
  documents: boolean;
  /** The webhook endpoints exist (`WEBHOOKS`): what `events` sends to. */
  webhooks: boolean;
  /** An approvable action of the subject is declared (ApprovalsRegistry). */
  approvals: boolean;
}

/**
 * What a subject's records take, for a client that shows a record's panels
 * (comments, attachments, tags, revisions, a PDF, approvals…) only where
 * they work: each capability of `record.ts` (CAPABILITIES) the subject
 * declares, off when the deployment switch it needs is off (`pdf` without
 * Gotenberg answers 503, `events` without WEBHOOKS has no endpoint), and
 * `approvals` when one of its actions is declared approvable.
 */
export function listCapabilities(
  declared: readonly Capability[],
  switches: CapabilitySwitches,
): ListCapabilities {
  const on: Partial<Record<Capability, boolean>> = {
    pdf: switches.documents,
    events: switches.webhooks,
  };
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((capability) => [
      capability,
      declared.includes(capability) && (on[capability] ?? true),
    ]),
  ) as Record<Capability, boolean>;
  return { ...capabilities, approvals: switches.approvals };
}
