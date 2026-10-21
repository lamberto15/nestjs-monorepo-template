import { hostname } from 'node:os';
import { currentOperator } from './operator.js';
import { OPS_JOB, opsPermissions } from './ops.jobs.js';

describe('the operator', () => {
  it('is the OS user and host of this process', () => {
    expect(currentOperator()).toEqual({
      user: expect.stringMatching(/\S/),
      host: hostname(),
    });
  });

  it('acts as the system job `ops`, which holds no permission', () => {
    expect(OPS_JOB.key).toBe('ops');
    expect(OPS_JOB.permissions).toEqual([]);
    expect(opsPermissions.systemJobs).toEqual([OPS_JOB]);
  });
});
