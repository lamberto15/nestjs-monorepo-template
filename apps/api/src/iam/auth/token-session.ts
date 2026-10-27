import { sql } from 'drizzle-orm';
import { refreshTokens } from '../iam.tables.js';

/**
 * The `sid` claim a refresh family's tokens carry (tokenClaims()), from the
 * claims the family keeps; null for a family signed in before it existed.
 * What a revocation reports to SessionLifecycleRegistry
 * (`afterTokenRevocation`): the realtime room of the family's sockets.
 */
export const tokenSessionId = sql<
  string | null
>`${refreshTokens.claims} ->> 'sid'`;

/** The `sid`s of revoked rows, each once (a family has a row per rotation). */
export const distinctTokenSessionIds = (rows: { sid: string | null }[]) => [
  ...new Set(
    rows.flatMap(({ sid }) => (typeof sid === 'string' && sid ? [sid] : [])),
  ),
];
