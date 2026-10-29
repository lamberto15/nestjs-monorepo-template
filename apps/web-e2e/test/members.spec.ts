import { randomUUID } from 'node:crypto';
import { account } from './accounts';
import { asRole, expect, test } from './fixtures';

test.describe('the administrator', () => {
  test.use(asRole('administrator'));

  test('prepares a member without an address, gives it one, sends it and withdraws it', async ({
    page,
  }) => {
    const email = `prepared-${randomUUID().slice(0, 8)}@example.com`;
    await page.goto('/access/users');

    await page.getByRole('button', { name: 'Prepare member' }).click();
    const prepare = page.getByRole('dialog', { name: 'Prepare a member' });
    await prepare.getByRole('button', { name: 'Save' }).click();
    await expect(prepare).toBeHidden();

    const invitations = page.getByRole('region', { name: 'Invitations' });
    const row = invitations
      .getByRole('row')
      .filter({ hasText: 'No address yet' })
      .first();
    await expect(row).toContainText('Prepared');
    await expect(row.getByRole('button', { name: 'Send' })).toBeDisabled();

    await row.getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog', { name: 'Change the invitation' });
    await edit.getByLabel(/Email/).fill(email);
    await edit.getByRole('button', { name: 'Save' }).click();
    // A new address asks for a recent sign-in (lib/api.ts repeats the request).
    const reauth = page.getByRole('dialog', { name: "Confirm it's you" });
    await expect(edit.or(reauth).first()).toBeVisible();
    await expect(
      reauth.or(page.getByText(`Invitation for ${email} saved.`)).first(),
    ).toBeVisible();
    if (await reauth.isVisible()) {
      await reauth
        .getByLabel('Password')
        .fill(account('administrator').password);
      await reauth.getByRole('button', { name: /Confirm/ }).click();
    }
    await expect(edit).toBeHidden();

    const mine = invitations.getByRole('row').filter({ hasText: email });
    await expect(mine).toContainText('Prepared');
    await mine.getByRole('button', { name: 'Send' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Send' })
      .click();
    await expect(mine.getByText('Sent').or(reauth).first()).toBeVisible();
    if (await reauth.isVisible()) {
      await reauth
        .getByLabel('Password')
        .fill(account('administrator').password);
      await reauth.getByRole('button', { name: /Confirm/ }).click();
    }
    await expect(mine).toContainText('Sent');

    await mine.getByRole('button', { name: 'Revoke' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Revoke' })
      .click();
    await expect(mine).toHaveCount(0);
  });
});
