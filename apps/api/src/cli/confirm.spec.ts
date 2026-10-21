import type { InquirerService } from 'nest-commander';
import { Confirmer, NotConfirmed } from './confirm.js';
import type { Plan } from './ops.service.js';

const plan: Plan<void> = {
  summary: ['Reset the password of a@example.com.'],
  apply: async () => undefined,
};

describe('Confirmer', () => {
  const ask = vi.fn();
  const confirmer = new Confirmer({ ask } as unknown as InquirerService);
  const tty = process.stdin.isTTY;

  beforeEach(() => {
    ask.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.stdin.isTTY = tty;
    vi.restoreAllMocks();
  });

  it('shows the summary and skips the question with --yes', async () => {
    process.stdin.isTTY = false;
    await confirmer.confirm(plan, true);
    expect(console.log).toHaveBeenCalledWith(plan.summary[0]);
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks on a terminal and goes on when told yes', async () => {
    process.stdin.isTTY = true;
    ask.mockResolvedValue({ proceed: true });
    await expect(confirmer.confirm(plan, false)).resolves.toBeUndefined();
    expect(ask).toHaveBeenCalledOnce();
  });

  it('stops when the operator declines', async () => {
    process.stdin.isTTY = true;
    ask.mockResolvedValue({ proceed: false });
    await expect(confirmer.confirm(plan, false)).rejects.toThrow(NotConfirmed);
  });

  it('stops, without asking, where there is no terminal and no --yes', async () => {
    process.stdin.isTTY = false;
    await expect(confirmer.confirm(plan, undefined)).rejects.toThrow(
      /pass --yes/,
    );
    expect(ask).not.toHaveBeenCalled();
  });
});
