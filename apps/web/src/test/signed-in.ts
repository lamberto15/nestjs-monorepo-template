import { http, HttpResponse } from 'msw/http';
import { allFeatures, server, signedInUser } from '@/test/server';

/**
 * Signs the user in with these permissions (`Subject.action`), and answers
 * what every signed-in page asks besides its own routes: the switches
 * (realtime off: no socket in a test), the bell's count, and the data
 * routes the lists' export and import buttons read (nothing to run unless a
 * test says so, features/transfer).
 */
export function useSignedIn(can: readonly string[]) {
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
        can: Object.fromEntries(can.map((p) => [p, true])),
      }),
    ),
    http.get('/v1/features', () =>
      HttpResponse.json({ ...allFeatures, realtime: false }),
    ),
    http.get('/v1/notifications/unread-count', () =>
      HttpResponse.json({ unread: 0 }),
    ),
    http.get('/v1/data', () => HttpResponse.json({ exports: [], imports: [] })),
  );
}
