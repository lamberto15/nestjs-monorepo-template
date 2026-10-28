/** The audit actions of a tenant's sign-in log (GET /v1/access/sign-ins; SignInLog writes them). */
export const SIGN_IN_ACTIONS = {
  succeeded: 'member.signed-in',
  failed: 'member.sign-in-failed',
} as const;

/** Both, for the queries and the partial indexes that must agree on them. */
export const SIGN_IN_ACTION_LIST = [
  SIGN_IN_ACTIONS.succeeded,
  SIGN_IN_ACTIONS.failed,
];
