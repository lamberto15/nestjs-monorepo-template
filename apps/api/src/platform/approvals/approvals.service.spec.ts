import type { I18nService } from '@nestjs/i18n';
import { ApprovalsService } from './approvals.service.js';

/** Only what the constructor and assertNotPending touch. */
function service(transactionActive: boolean) {
  const register = () => undefined;
  const txHost = { isTransactionActive: () => transactionActive, tx: {} };
  return new ApprovalsService(
    txHost as never,
    {} as never, // registry
    { applying: () => undefined } as never, // engine
    {} as never, // policies
    {} as never, // workflows
    {} as never, // settings
    {} as never, // access
    { translate: (key: string) => key } as unknown as I18nService,
    { register } as never, // record purges
    { register } as never, // personal data
    { register } as never, // user lifecycle
  );
}

describe('ApprovalsService.assertNotPending', () => {
  it('refuses to run outside a transaction: its record lock would protect nothing', async () => {
    await expect(service(false).assertNotPending('Note', 'n1')).rejects.toThrow(
      /outside a transaction/,
    );
  });
});
