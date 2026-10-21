import { SetMetadata } from '@nestjs/common';

/** The refusal's code (the problem's `code`). */
export const ONBOARDING_REQUIRED = 'onboarding_required';

export const DURING_ONBOARDING = Symbol('onboarding-allowed');

/**
 * A route the first administrator may reach before finishing onboarding
 * (docs/auth.md, "Administrator onboarding"): replacing the placeholder
 * address and verifying it, changing the generated password, setting up
 * two-factor or a passkey, who am I, and leaving. Routes that also serve a
 * user who must enrol in two-factor carry `@DuringMfaEnrollment()` too: the
 * two guards never lock each other out.
 */
export const DuringOnboarding = () => SetMetadata(DURING_ONBOARDING, true);

/**
 * Addresses nobody can read mail at: the template's default ADMIN_EMAIL
 * (`admin@example.com`) and the reserved domains (RFC 2606 / 6761).
 */
const PLACEHOLDER_DOMAINS =
  /(^|\.)(example\.(com|net|org)|invalid|test|localhost|example)$/;

export const isPlaceholderEmail = (email: string) =>
  PLACEHOLDER_DOMAINS.test(email.trim().toLowerCase().split('@').pop() ?? '');
