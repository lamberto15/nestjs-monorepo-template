import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpsEventData } from './types';

/** The log keeps this many events, newest first: the browser's memory is not the API's. */
export const MAX_EVENTS = 200;

/** A line of the log, its texts made once when the event arrived. */
export type LogEntry = {
  id: number;
  source: string;
  /** Epoch ms. */
  at: number;
  /** What the event is about: its `type` (the outbox's, the workflow's…) when it has one. */
  kind: string;
  /** The rest of the event as one line of text, cut short. */
  detail: string;
};

/** A line of the log shows at most this much of an event's details. */
const DETAIL_LIMIT = 300;

function kindOf(event: OpsEventData): string {
  for (const key of ['type', 'event', 'name', 'kind']) {
    const value = event[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
}

function detailOf(event: OpsEventData): string {
  const { source: _source, at: _at, ...rest } = event;
  const text = JSON.stringify(rest) ?? '';
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}
export type StreamStatus = 'connecting' | 'open' | 'closed';

/** `EventSource.CLOSED`: the browser gave up (a refusal, 401 or 403, included) and won't retry. */
const CLOSED = 2;

/**
 * The live log (`GET /v1/ops/events`, Server-Sent Events). The browser's
 * `EventSource` is the documented way: the session cookie is the API's only
 * credential, it rides on a same-origin request (`withCredentials` is for
 * cross-origin ones), so no header is needed and no secret reaches the
 * bundle. The browser reconnects by itself after a dropped connection
 * (status `connecting` meanwhile); a refusal ends it (`closed`). The stream
 * is closed when `live` turns off and when the component unmounts, and the
 * log is capped at {@link MAX_EVENTS}.
 */
export function useOpsEvents(live: boolean) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [state, setStatus] = useState<StreamStatus>('connecting');
  const [attempt, setAttempt] = useState(0);
  const nextId = useRef(0);

  useEffect(() => {
    if (!live || typeof EventSource === 'undefined') {
      return;
    }
    const source = new EventSource('/v1/ops/events');
    source.onopen = () => setStatus('open');
    source.onmessage = (message: MessageEvent<string>) => {
      let event: unknown;
      try {
        event = JSON.parse(message.data);
      } catch {
        return; // Not one of ours: a log line must not break the page.
      }
      if (typeof event !== 'object' || event === null) {
        return;
      }
      const data = event as OpsEventData;
      const entry: LogEntry = {
        id: nextId.current++,
        source: typeof data.source === 'string' ? data.source : '',
        at: typeof data.at === 'number' ? data.at : Date.now(),
        kind: kindOf(data),
        detail: detailOf(data),
      };
      setEntries((current) => [entry, ...current].slice(0, MAX_EVENTS));
    };
    source.onerror = () =>
      setStatus(source.readyState === CLOSED ? 'closed' : 'connecting');
    return () => {
      source.close();
      setStatus('connecting'); // For the next connection.
    };
  }, [live, attempt]);

  // Not live (paused, or no EventSource in this browser): no connection.
  const status: StreamStatus =
    live && typeof EventSource !== 'undefined' ? state : 'closed';
  const clear = useCallback(() => setEntries([]), []);
  /** Opens the stream anew, after a refusal or a connection that ended. */
  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);
  return { entries, status, clear, reconnect };
}
