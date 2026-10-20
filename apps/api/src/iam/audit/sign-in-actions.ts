/** The audit actions of a tenant's sign-in log (GET /v1/access/sign-ins; SignInLog writes them). */
export const SIGN_IN_ACTIONS = {
  succeeded: 'member.signed-in',
  failed: 'member.sign-in-failed',
} as const;
