import type { BulkSelection } from './api';

/** What a list page hands its bulk actions: the selection and how to end it. */
export interface BulkContext {
  /** The chosen ids, or (all matching) the list's filter. */
  selection: BulkSelection;
  /** How many records the selection stands for. */
  count: number;
  /** Clears the selection (call it when a run ends). */
  clear: () => void;
}
