import { SchedulerRegistry } from '@nestjs/schedule';

/**
 * ModeService with the scheduler loaded (a worker: SCHEDULER on, APP_ROLE
 * all): the app boots, and a restricted mode stops the cron jobs, normal
 * starts them again. The suite runs with SCHEDULER=off (setup-env.ts), so
 * this file turns it on before the app module is imported.
 */
describe('mode with the scheduler (e2e)', () => {
  it('boots and stops and starts the cron jobs with the mode', async () => {
    process.env.SCHEDULER = 'on';
    const { bootApp } = await import('./support.js');
    const { ModeService } =
      await import('../src/platform/mode/mode.service.js');
    const node = await bootApp();
    try {
      const registry = node.app.get(SchedulerRegistry);
      const jobs = [...registry.getCronJobs().values()];
      expect(jobs.length).toBeGreaterThan(0);
      await node
        .admin()
        .put('/v1/settings/platform.mode/platform')
        .send({ value: 'read-only' })
        .expect(200);
      await node.app.get(ModeService).refresh();
      expect(node.app.get(ModeService).current()).toBe('read-only');
      expect(jobs.filter((job) => job.isActive).length).toBe(0);
      await node
        .admin()
        .delete('/v1/settings/platform.mode/platform')
        .expect(204);
      await node.app.get(ModeService).refresh();
      expect(jobs.some((job) => job.isActive)).toBe(true);
    } finally {
      await node.close();
      process.env.SCHEDULER = 'off';
    }
  });
});
