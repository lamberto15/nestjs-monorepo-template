import { Logger } from '@nestjs/common';
import pg from 'pg';
import { DatabaseIncidents } from './database-incidents.js';

const fake = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
}));
vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(function () {
      return fake;
    }),
  },
}));

describe('database incident snapshots', () => {
  let capture: DatabaseIncidents;
  let warnings: ReturnType<typeof vi.spyOn>;
  const stats = () => ({ max: 10, inUse: 10, idle: 0, waiting: 4 });
  beforeEach(() => {
    vi.clearAllMocks();
    warnings = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    capture = new DatabaseIncidents(stats, 'postgres://monitor:secret@db/app');
  });
  afterEach(async () => {
    vi.useRealTimers();
    await capture.close();
    vi.restoreAllMocks();
  });
  const logs = () => warnings.mock.calls.map((call) => call[1]);

  it('uses a dedicated single-connection pool and a bounded statistics-only query', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [{ pid: 4, blockingPids: [3] }] });
    const release = vi.fn();
    fake.connect.mockResolvedValue({ query, release });
    const incident = capture.record({ trigger: 'database_busy' });
    await vi.waitFor(() => expect(release).toHaveBeenCalled());
    expect(pg.Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        max: 1,
        statement_timeout: 1000,
        connectionTimeoutMillis: 1000,
      }),
    );
    const sql = query.mock.calls[1][0] as string;
    expect(sql).toContain('limit 20');
    expect(sql).toContain('pg_blocking_pids(pid)');
    expect(sql).not.toMatch(/\bquery\s*[, ]/);
    expect(sql).not.toContain('from notes');
    expect(logs()).toContainEqual(
      expect.objectContaining({
        incidentId: incident.incidentId,
        captureStatus: 'captured',
        observations: { blockedSessions: 1, applicationPoolWaiting: 4 },
      }),
    );
    expect(JSON.stringify(logs())).not.toContain('secret');
  });

  it('logs every failure while allowing only one capture and a 30-second cooldown', async () => {
    let connected!: (value: unknown) => void;
    fake.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          connected = resolve;
        }),
    );
    expect(capture.record({ trigger: 'database_busy' }).captureStatus).toBe(
      'pending',
    );
    expect(capture.record({ trigger: 'database_timeout' }).captureStatus).toBe(
      'in_progress',
    );
    connected({
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ allowed: true }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(logs()).toContainEqual(
        expect.objectContaining({ captureStatus: 'captured' }),
      ),
    );
    expect(capture.record({ trigger: 'slow_query' }).captureStatus).toBe(
      'cooldown',
    );
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(
      logs().filter(
        (l) => (l as { event?: string }).event === 'database_incident',
      ),
    ).toHaveLength(3);
  });

  it('destroys an active diagnostic connection at the one-second total deadline', async () => {
    vi.useFakeTimers();
    const release = vi.fn();
    fake.connect.mockResolvedValue({
      query: () => new Promise(() => {}),
      release,
    });
    capture.record({ trigger: 'database_busy' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(release).toHaveBeenCalledWith(true);
    expect(logs()).toContainEqual(
      expect.objectContaining({
        captureStatus: 'unavailable',
        reason: 'capture_timeout',
      }),
    );
  });

  it('releases a connection that arrives after the deadline', async () => {
    vi.useFakeTimers();
    let connected!: (value: unknown) => void;
    fake.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          connected = resolve;
        }),
    );
    capture.record({ trigger: 'slow_query' });
    await vi.advanceTimersByTimeAsync(1000);
    const release = vi.fn();
    const query = vi.fn();
    connected({ query, release });
    await vi.advanceTimersByTimeAsync(1);
    expect(release).toHaveBeenCalledWith(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects non-monitor credentials without reading activity and redacts unexpected errors', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ allowed: false }] });
    fake.connect.mockResolvedValue({ query, release: vi.fn() });
    capture.record({ trigger: 'database_busy' });
    await vi.waitFor(() =>
      expect(logs()).toContainEqual(
        expect.objectContaining({ reason: 'monitor_role_required' }),
      ),
    );
    expect(query).toHaveBeenCalledTimes(1);
    await capture.close();
    capture = new DatabaseIncidents(stats, 'postgres://monitor:secret@db/app');
    fake.connect.mockRejectedValue(
      new Error('connection failed: secret private-note'),
    );
    capture.record({ trigger: 'database_timeout' });
    await vi.waitFor(() =>
      expect(logs()).toContainEqual(
        expect.objectContaining({ reason: 'monitor_unavailable' }),
      ),
    );
    expect(JSON.stringify(logs())).not.toContain('secret');
  });

  it('records explicitly when monitoring is unconfigured or shut down', async () => {
    await capture.close();
    capture = new DatabaseIncidents(stats);
    expect(capture.record({ trigger: 'database_busy' }).captureStatus).toBe(
      'unconfigured',
    );
    await capture.close();
    expect(capture.record({ trigger: 'database_busy' }).captureStatus).toBe(
      'closed',
    );
  });
});
