import { http, HttpResponse } from 'msw/http';
import { screen, waitFor } from '@testing-library/react';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '@/i18n';
import { api } from '@/lib/api';
import { renderApp } from '@/test/render-app';
import { findToast } from '@/test/toast';
import { allFeatures, problem, server, signedInUser } from '@/test/server';

const unavailable = "Two-factor can't be set up on this deployment.";

/** The security page's API for a user without an authenticator. */
function useMfaApi(
  options: {
    features?: 'off' | 'forbidden' | 'on';
    required?: boolean;
    enrollments?: { count: number };
  } = {},
) {
  const enrollments = options.enrollments ?? { count: 0 };
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
        mfaEnrollmentRequired: options.required ?? false,
      }),
    ),
    http.get('/v1/features', () => {
      if (options.features === 'forbidden') {
        return problem(403, 'mfa_enrollment_required');
      }
      return HttpResponse.json({
        ...allFeatures,
        mfa: options.features !== 'off',
      });
    }),
    http.get('/v1/auth/mfa', () =>
      HttpResponse.json({
        enabled: false,
        remainingRecoveryCodes: 0,
      }),
    ),
    http.post('/v1/auth/mfa/enroll', () => {
      enrollments.count++;
      return HttpResponse.json({
        secret: 'JBSWY3DPEHPK3PXP',
        uri: 'otpauth://totp/acme:ada?secret=JBSWY3DPEHPK3PXP',
      });
    }),
    http.get('/v1/auth/sessions', () => HttpResponse.json({ items: [] })),
    http.get('/v1/auth/identities', () => HttpResponse.json({ items: [] })),
    http.get('/v1/auth/passkeys', () => HttpResponse.json({ items: [] })),
    http.get('/v1/auth/methods', () => HttpResponse.json({})),
  );
  return enrollments;
}

describe('the two-factor section', () => {
  it('offers setting up while the switches are not known (the features call failed)', async () => {
    useMfaApi({ features: 'forbidden' });
    await renderApp('/account/security');
    expect(
      await screen.findByRole('button', { name: 'Set up two-factor' }),
    ).toBeVisible();
    expect(screen.queryByText(unavailable)).toBeNull();
  });

  it('says it is unavailable only when the deployment turned it off', async () => {
    useMfaApi({ features: 'off' });
    await renderApp('/account/security');
    expect(await screen.findByText(unavailable)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Set up two-factor' }),
    ).toBeNull();
  });

  it('leads straight to enrolment when the API says it is required, whatever the features said', async () => {
    const enrollments = useMfaApi({ features: 'forbidden', required: true });
    await renderApp('/account/security');
    expect(
      await screen.findByLabelText('QR code for your authenticator app'),
    ).toBeVisible();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeVisible();
    expect(screen.queryByText(unavailable)).toBeNull();
    expect(enrollments.count).toBe(1);
  });
});

describe('a 403 mfa_enrollment_required from a query', () => {
  // The global error handler words its toast with the app's own i18n.
  beforeAll(async () => {
    await initI18n();
  });

  it('sends the user to the setup page with an explanation', async () => {
    useMfaApi();
    const { history, queryClient } = await renderApp('/account/preferences');
    // Any query of the shell, answered the way the API restricts the session.
    server.use(
      http.get('/v1/auth/sessions', () =>
        problem(403, 'mfa_enrollment_required'),
      ),
    );
    await queryClient
      .fetchQuery({
        queryKey: ['sessions'],
        queryFn: () => unwrap(api.GET('/v1/auth/sessions')),
      })
      .catch(() => undefined);
    await waitFor(() =>
      expect(history.location.pathname).toBe('/account/security'),
    );
    expect(
      await findToast(
        'You need to set up two-factor authentication before you can continue.',
      ),
    ).toBeVisible();
  });
});
