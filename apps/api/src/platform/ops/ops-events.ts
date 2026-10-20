import { Logger } from '@nestjs/common';
import { redactValue } from '../../core/logging/redaction.js';
import { opsEventSchema, type OpsEvent } from './ops.schemas.js';

const logger = new Logger('OpsEvents');

/** An error of any shape an engine holds, as `{ name?, message }`: never a stack. */
function errorOf(value: unknown): { name?: string; message: string } {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === 'string') {
    return { message: value };
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string'
  ) {
    const { name, message } = value as { name?: unknown; message: string };
    return typeof name === 'string' ? { name, message } : { message };
  }
  return { message: 'Unknown error' };
}

/**
 * One engine's event, as the operations stream sends it: tagged with its
 * `source`, its error reduced to a name and a message, every value passed
 * through the log-redaction registry (a secret by name, a credential in a
 * text, an over-long text cut), then checked against `opsEventSchema`, which
 * drops whatever it doesn't declare. The browser gets nothing the logs
 * wouldn't.
 *
 * An event the schema refuses (an engine update added a shape) is logged and
 * left out of the stream, which carries on: a dashboard missing one line beats
 * a dropped connection. The unit spec holds a sample of every event type, typed
 * by the engines' own interfaces, so an update that adds a shape fails CI first.
 */
export function opsEvent(
  source: OpsEvent['source'],
  event: object,
  at = Date.now(),
): OpsEvent | undefined {
  // The resilience events have a `source` of their own (what the policy
  // guards), which used to overwrite the tag: it is `origin` here.
  const { source: origin, ...rest } = event as { source?: unknown };
  const tagged: Record<string, unknown> = { at, ...rest, source };
  if (origin !== undefined) {
    tagged.origin = origin;
  }
  if ('error' in tagged && tagged.error != null) {
    tagged.error = errorOf(tagged.error);
  }
  const parsed = opsEventSchema.safeParse(redactValue(tagged));
  if (!parsed.success) {
    logger.warn(
      `An ${source} event (${String((event as { type?: unknown }).type)}) does not match the operations schema, left out of the stream: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
    return undefined;
  }
  return parsed.data;
}
