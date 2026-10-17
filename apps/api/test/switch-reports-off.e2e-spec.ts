import { ReportRunnerJob } from '../src/platform/reports/report-runner.job.js';
import { ReportsService } from '../src/platform/reports/reports.service.js';
import { bootApp, type TestApp } from './support.js';

vi.hoisted(() => {
  process.env.REPORTS = 'off';
});

/** REPORTS=off: no reports API, no runner; exports are untouched. */
describe('REPORTS=off (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  it('leaves /v1/reports out (404)', async () => {
    const res = await node.admin().get('/v1/reports').expect(404);
    expect(res.body.code).toBe('not_found');
    await node
      .admin()
      .post('/v1/reports')
      .send({ name: 'x', exporter: 'test-items', format: 'csv' })
      .expect(404);
  });

  it('registers neither the service nor the hourly runner', () => {
    expect(() => node.app.get(ReportsService, { strict: false })).toThrow();
    expect(() => node.app.get(ReportRunnerJob, { strict: false })).toThrow();
  });

  it('still serves the rest of the API', async () => {
    await node.admin().get('/v1/test-items').expect(200);
  });
});
