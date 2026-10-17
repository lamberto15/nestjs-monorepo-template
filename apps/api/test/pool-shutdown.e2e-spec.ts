import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { testDatabase } from './support.js';

// Regression: a maintenance-role connection still ending when its database
// is force-dropped surfaced 57P01 as an unhandled 'error' (flaky CI run).
describe('closing a test database', () => {
  it('waits for the maintenance role connections before the drop', async () => {
    for (let i = 0; i < 5; i++) {
      const database = await testDatabase();
      // No 'error' listener on purpose: the unhandled event is the failure.
      const pool = new Pool({
        connectionString: database.maintenanceUrl,
        max: 3,
      });
      await Promise.all([pool.query('select 1'), pool.query('select 2')]);
      void pool.end(); // not awaited: the pool is still ending at the drop
      await expect(database.close()).resolves.toBeUndefined();
    }
  });
});
