import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfirmButton } from '@/components/confirm-button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useAppForm } from '@/lib/form';
import type { Mode } from '@/lib/mode';
import { featuresQuery } from '@/lib/session';
import { allFeatures } from '@/test/server';
import { renderComponent } from '@/test/render-component';

// The controls that write are off while the API refuses writes (read-only,
// maintenance), unless their route stays open in both (`allowInMaintenance`,
// as the API's `@AllowInMaintenance()`).

function Form(props: { allowInMaintenance?: boolean }) {
  const form = useAppForm({ defaultValues: {}, onSubmit: () => undefined });
  return (
    <form.AppForm>
      <form.SubmitButton allowInMaintenance={props.allowInMaintenance}>
        Save
      </form.SubmitButton>
    </form.AppForm>
  );
}

const controls = {
  'a form submit button': (props: { allowInMaintenance?: boolean }) => (
    <Form {...props} />
  ),
  'a confirm button': (props: { allowInMaintenance?: boolean }) => (
    <ConfirmButton
      title="Sure?"
      description="This changes things."
      confirm="Do it"
      onConfirm={async () => undefined}
      {...props}
    >
      Save
    </ConfirmButton>
  ),
};

/** The component, with the deployment in `mode` (undefined: the switches are not known). */
const show = (ui: Parameters<typeof renderComponent>[0], mode?: Mode) =>
  renderComponent(ui, mode ? { features: { mode } } : {});

describe.each(Object.entries(controls))('%s', (_name, control) => {
  const save = () => screen.getByRole('button', { name: 'Save' });

  it.each(['normal', undefined] as const)(
    'works while the mode is %s (undefined: not asked, as on the signed-out pages)',
    async (mode) => {
      await show(control({}), mode);
      expect(save()).toBeEnabled();
    },
  );

  it.each(['read-only', 'maintenance'] as const)(
    'is off in %s mode',
    async (mode) => {
      await show(control({}), mode);
      expect(save()).toBeDisabled();
    },
  );

  it.each(['read-only', 'maintenance'] as const)(
    'stays on in %s mode when its route is open there',
    async (mode) => {
      await show(control({ allowInMaintenance: true }), mode);
      expect(save()).toBeEnabled();
    },
  );

  it('comes back when the mode does', async () => {
    const { queryClient } = await show(control({}), 'read-only');
    expect(save()).toBeDisabled();
    await act(async () => {
      queryClient.setQueryData(featuresQuery.queryKey, {
        ...allFeatures,
        mode: 'normal',
      });
    });
    // Observers are told on the notify manager's next tick.
    await waitFor(() => expect(save()).toBeEnabled());
  });
});

describe('a confirmation dialog', () => {
  const dialog = (allowInMaintenance?: boolean) => (
    <ConfirmDialog
      open
      onOpenChange={() => undefined}
      title="Sure?"
      description="This changes things."
      confirm="Do it"
      onConfirm={async () => undefined}
      allowInMaintenance={allowInMaintenance}
    />
  );

  it('cannot be confirmed while the API refuses writes', async () => {
    await show(dialog(), 'read-only');
    expect(await screen.findByRole('button', { name: 'Do it' })).toBeDisabled();
  });

  it('can, in normal mode and for a route open in every mode', async () => {
    await show(dialog(), 'normal');
    expect(await screen.findByRole('button', { name: 'Do it' })).toBeEnabled();
  });

  it('can be confirmed in maintenance for a route open in every mode', async () => {
    await show(dialog(true), 'maintenance');
    expect(await screen.findByRole('button', { name: 'Do it' })).toBeEnabled();
  });
});
