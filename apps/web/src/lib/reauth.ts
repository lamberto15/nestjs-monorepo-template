import { useSyncExternalStore } from 'react';
import type { Problem } from '@nestjs-monorepo-template/api-client';

/** What a 403 `reauthentication_required` says (docs/auth.md, "Step-up"). */
export type ReauthProblem = Problem & {
  methods?: string[];
  mfaRequired?: boolean;
};

type Pending = { problem: ReauthProblem; resolve: (ok: boolean) => void };

let pending: Pending | null = null;
let waiting: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Asks the user to confirm it's them (the re-authenticate dialog) and
 * resolves true once they did, false when they gave up. Requests made while
 * the dialog is open share it.
 */
export function requestReauthentication(
  problem: ReauthProblem,
): Promise<boolean> {
  if (waiting) {
    return waiting;
  }
  waiting = new Promise<boolean>((resolve) => {
    pending = { problem, resolve };
    emit();
  });
  return waiting;
}

/** The dialog's answer. */
export function settleReauthentication(ok: boolean) {
  const current = pending;
  pending = null;
  waiting = null;
  emit();
  current?.resolve(ok);
}

/**
 * The session changed under an open dialog (signed out, another tenant or
 * account, here or in another tab): the waiting requests were built for the
 * previous session and are never sent again under the new cookie. They fail
 * as the user giving up does (lib/api.ts); lib/session.ts calls this from
 * its reset and clear.
 */
export function cancelReauthentication() {
  if (pending) {
    settleReauthentication(false);
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The open request, or null. */
export function useReauthRequest(): ReauthProblem | null {
  return useSyncExternalStore(
    subscribe,
    () => pending?.problem ?? null,
    () => null,
  );
}
