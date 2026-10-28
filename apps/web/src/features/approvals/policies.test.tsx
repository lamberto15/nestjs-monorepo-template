import { act, screen, waitFor, within } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { expectNoToast, findToast } from '@/test/toast';
import { allFeatures, problem, server, signedInUser } from '@/test/server';

const KEY = 'TestItem.publish';

const stage = (over: Record<string, unknown> = {}) => ({
  name: 'Editor review',
  approvers: [{ type: 'role', role: 'editor' }],
  mode: { type: 'any' },
  onOverdue: 'expire',
  ...over,
});

const policyOf = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  stages: [stage()],
  resubmitWithin: '30d',
  ...over,
});

const view = (over: Record<string, unknown> = {}) => ({
  key: KEY,
  subject: 'TestItem',
  action: 'publish',
  label: 'Publish a test item',
  description: null,
  version: 0,
  source: 'code',
  policy: policyOf(),
  default: policyOf(),
  setting: 'testItems.publishApproval',
  payloadSchema: {
    type: 'object',
    properties: { title: { type: 'string' }, amount: { type: 'number' } },
  },
  ...over,
});

const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** What `GET /v1/approvals/policy-types` answers: the built-in types and their JSON Schema. */
const types = {
  approverRules: [
    {
      type: 'role',
      label: 'Users holding a role',
      params: object({ role: { type: 'string', maxLength: 100 } }, ['role']),
    },
    {
      type: 'permission',
      label: 'Users who may do an action on the record',
      params: object(
        { action: { type: 'string' }, subject: { type: 'string' } },
        ['action'],
      ),
    },
    {
      type: 'users',
      label: 'Named users',
      params: object(
        { userIds: { type: 'array', items: { type: 'string' } } },
        ['userIds'],
      ),
    },
  ],
  modes: [
    { type: 'any', label: 'Any approver', params: object({}) },
    {
      type: 'quorum',
      label: 'A quorum of approvers',
      params: object({ n: { type: 'integer', minimum: 1, maximum: 100 } }, [
        'n',
      ]),
    },
  ],
  conditions: [
    {
      type: 'all',
      label: 'all of conditions',
      params: object({ conditions: { type: 'array', items: {} } }, [
        'conditions',
      ]),
    },
    {
      type: 'not',
      label: 'not of conditions',
      params: object({ condition: {} }, ['condition']),
    },
    {
      type: 'between',
      label: 'A range',
      params: object({ range: { type: 'array', items: { type: 'number' } } }, [
        'range',
      ]),
    },
    {
      type: 'payload',
      label: 'A value of the proposed change',
      params: object(
        {
          path: { type: 'string' },
          op: {
            type: 'string',
            enum: [
              'eq',
              'ne',
              'gt',
              'gte',
              'lt',
              'lte',
              'in',
              'notIn',
              'exists',
            ],
          },
          value: {},
        },
        ['path', 'op'],
      ),
    },
  ],
};

type Options = {
  policy?: ReturnType<typeof view>;
  can?: Record<string, boolean>;
};

/** The policies API as the admin pages see it; `puts` and `deletes` record what was sent. */
function mockPoliciesApi(options: Options = {}) {
  const state = {
    policy: options.policy ?? view(),
    puts: [] as { body: any; ifMatch: string | null }[],
    deletes: [] as { ifMatch: string | null }[],
  };
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
        can: options.can ?? { 'Approval.managePolicies': true },
      }),
    ),
    http.get('/v1/features', () => HttpResponse.json(allFeatures)),
    http.get('/v1/notifications/unread-count', () =>
      HttpResponse.json({ unread: 0 }),
    ),
    http.get('/v1/approvals/policy-types', () => HttpResponse.json(types)),
    http.get('/v1/approvals/policies', () =>
      HttpResponse.json({ items: [state.policy] }),
    ),
    http.get('/v1/approvals/policies/:key', () =>
      HttpResponse.json(state.policy, {
        headers: { etag: `"v${state.policy.version}"` },
      }),
    ),
    http.put('/v1/approvals/policies/:key', async ({ request }) => {
      const body = await request.json();
      state.puts.push({ body, ifMatch: request.headers.get('if-match') });
      state.policy = view({
        version: state.policy.version + 1,
        source: 'override',
        policy: body,
      });
      return HttpResponse.json(state.policy);
    }),
    http.delete('/v1/approvals/policies/:key', ({ request }) => {
      state.deletes.push({ ifMatch: request.headers.get('if-match') });
      state.policy = view({ version: state.policy.version + 1 });
      return HttpResponse.json(state.policy);
    }),
  );
  return state;
}

describe('the approval policies page', () => {
  it('lists the actions with their policy in force', async () => {
    mockPoliciesApi({
      policy: view({
        version: 3,
        source: 'override',
        policy: policyOf({
          stages: [stage(), stage({ name: 'Finance' })],
          when: { type: 'payload', path: 'amount', op: 'gt', value: 1000 },
        }),
      }),
    });
    await renderApp('/approval-policies');
    const list = await screen.findByRole('list', { name: 'Approval policies' });
    const row = within(list).getByRole('listitem');
    expect(
      within(row).getByRole('link', { name: 'Publish a test item' }),
    ).toHaveAttribute('href', `/approval-policies/${KEY}`);
    expect(within(row).getByText(KEY)).toBeVisible();
    expect(within(row).getByText('Customized (version 3)')).toBeVisible();
    expect(within(row).getByText('Conditional')).toBeVisible();
    expect(
      within(row).getByText('Stages: Editor review → Finance'),
    ).toBeVisible();
  });

  it('marks the code default, and an action switched off', async () => {
    mockPoliciesApi({ policy: view({ policy: policyOf({ enabled: false }) }) });
    await renderApp('/approval-policies');
    expect(await screen.findByText('Default')).toBeVisible();
    expect(screen.getByText('Off')).toBeVisible();
  });

  it('is in the menu for whoever manages policies', async () => {
    mockPoliciesApi();
    await renderApp('/');
    // Its group (Configuration) starts folded away from its pages.
    await userEvent.click(
      await screen.findByRole('button', { name: 'Configuration' }),
    );
    expect(
      await screen.findByRole('link', { name: 'Approval policies' }),
    ).toBeVisible();
  });

  it('is not in the menu, and the route refuses, without the permission', async () => {
    mockPoliciesApi({ can: {} });
    const { router } = await renderApp('/approval-policies');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(
      screen.queryByRole('link', { name: 'Approval policies' }),
    ).not.toBeInTheDocument();
  });
});

describe('editing a policy', () => {
  async function open(options: Options = {}) {
    const api = mockPoliciesApi(options);
    const user = userEvent.setup();
    await renderApp(`/approval-policies/${KEY}`);
    await screen.findByRole('heading', { name: 'Publish a test item' });
    await screen.findByRole('region', { name: 'Stage 1' });
    return { api, user };
  }

  it('shows the stages, and saves a changed one with the ETag it read', async () => {
    const { api, user } = await open();
    const stage1 = screen.getByRole('region', { name: 'Stage 1' });
    expect(within(stage1).getByLabelText('Name')).toHaveValue('Editor review');
    expect(within(stage1).getByLabelText('Role')).toHaveValue('editor');

    await user.clear(within(stage1).getByLabelText('Name'));
    await user.type(within(stage1).getByLabelText('Name'), 'Review');
    await user.clear(within(stage1).getByLabelText('Role'));
    await user.type(within(stage1).getByLabelText('Role'), 'admin');
    await user.type(within(stage1).getByLabelText('Remind after'), '1d');
    await user.type(within(stage1).getByLabelText('Overdue after'), '3d');
    await user.click(screen.getByRole('button', { name: 'Save policy' }));

    await findToast('Policy saved.');
    expect(api.puts).toEqual([
      {
        ifMatch: '"v0"',
        body: {
          enabled: true,
          stages: [
            {
              name: 'Review',
              approvers: [{ type: 'role', role: 'admin' }],
              mode: { type: 'any' },
              remindAfter: '1d',
              dueAfter: '3d',
              onOverdue: 'expire',
            },
          ],
          resubmitWithin: '30d',
        },
      },
    ]);
    // The saved version is what the page shows now.
    expect(await screen.findByText('Customized (version 1)')).toBeVisible();
  });

  it('adds a stage with a quorum and a second approver rule', async () => {
    const { api, user } = await open();
    await user.click(screen.getByRole('button', { name: 'Add a stage' }));
    const stage2 = await screen.findByRole('region', { name: 'Stage 2' });
    await user.type(within(stage2).getByLabelText('Name'), 'Finance');

    await user.click(
      within(stage2).getByRole('button', { name: 'Add an approver rule' }),
    );
    await user.click(
      within(stage2).getByRole('combobox', { name: 'Approver 2' }),
    );
    await user.click(
      await screen.findByRole('option', { name: 'Named users' }),
    );
    const group = within(stage2).getByRole('group', { name: 'Approver 2' });
    await user.type(
      within(group).getByRole('textbox'),
      '0199a3f2-0000-7000-8000-000000000009,',
    );

    await user.click(
      within(stage2).getByRole('combobox', { name: 'How the stage completes' }),
    );
    await user.click(
      await screen.findByRole('option', { name: 'A quorum of approvers' }),
    );
    const quorum = within(stage2).getByLabelText('Approvals needed');
    expect(quorum).toHaveValue(1);
    await user.clear(quorum);
    await user.type(quorum, '2');
    await user.click(screen.getByRole('button', { name: 'Save policy' }));

    await findToast('Policy saved.');
    expect(api.puts[0]!.body.stages[1]).toEqual({
      name: 'Finance',
      approvers: [
        { type: 'role', role: '' },
        { type: 'users', userIds: ['0199a3f2-0000-7000-8000-000000000009'] },
      ],
      mode: { type: 'quorum', n: 2 },
      onOverdue: 'expire',
    });
  });

  it('removes and reorders stages', async () => {
    const { api, user } = await open({
      policy: view({
        policy: policyOf({
          stages: [stage({ name: 'First' }), stage({ name: 'Second' })],
        }),
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Move stage 2 up' }));
    expect(
      within(screen.getByRole('region', { name: 'Stage 1' })).getByLabelText(
        'Name',
      ),
    ).toHaveValue('Second');
    await user.click(screen.getByRole('button', { name: 'Remove stage 2' }));
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    await findToast('Policy saved.');
    expect(
      api.puts[0]!.body.stages.map((s: { name: string }) => s.name),
    ).toEqual(['Second']);
  });

  it('turns on a condition on the proposed change', async () => {
    const { api, user } = await open();
    await user.click(
      screen.getByRole('switch', { name: 'Only when a condition holds' }),
    );
    const condition = await screen.findByRole('group', { name: 'Condition' });
    // The fields of the proposed change are listed to write the path from.
    expect(
      screen.getByText(/Fields of the proposed change: title, amount/),
    ).toBeVisible();
    await user.type(within(condition).getByLabelText('Path'), 'amount');
    await user.click(
      within(condition).getByRole('combobox', { name: 'Comparison' }),
    );
    await user.click(
      await screen.findByRole('option', { name: 'is greater than' }),
    );
    await user.type(within(condition).getByLabelText('Value'), '1000');
    await user.click(screen.getByRole('button', { name: 'Save policy' }));

    await findToast('Policy saved.');
    expect(api.puts[0]!.body.when).toEqual({
      type: 'payload',
      path: 'amount',
      op: 'gt',
      value: 1000,
    });
  });

  it('nests conditions in an all', async () => {
    const { api, user } = await open({
      policy: view({
        policy: policyOf({
          when: {
            type: 'all',
            conditions: [
              { type: 'payload', path: 'amount', op: 'gt', value: 5 },
            ],
          },
        }),
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Add a condition' }));
    expect(
      await screen.findByRole('group', { name: 'Condition 2' }),
    ).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Remove Condition 1' }),
    );
    // What is shown is what is saved: the survivor has no value, and the
    // removed condition's 5 must not linger in its field.
    const survivor = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(survivor).getByLabelText('Path')).toHaveValue('');
    expect(within(survivor).getByLabelText('Value')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    await findToast('Policy saved.');
    expect(api.puts[0]!.body.when).toEqual({
      type: 'all',
      conditions: [{ type: 'payload', path: '', op: 'eq' }],
    });
  });

  it('does not send an optional text left empty', async () => {
    const { api, user } = await open();
    const stage1 = screen.getByRole('region', { name: 'Stage 1' });
    await user.click(
      within(stage1).getByRole('combobox', { name: 'Approver 1' }),
    );
    await user.click(
      await screen.findByRole('option', {
        name: 'Users who may do an action on the record',
      }),
    );
    await user.type(within(stage1).getByLabelText('Permission'), 'update');
    await user.type(within(stage1).getByLabelText('Subject'), 'Note');
    await user.clear(within(stage1).getByLabelText('Subject'));
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    await findToast('Policy saved.');
    // `subject` is optional with a minimum length of 1: unset, not ''.
    expect(api.puts[0]!.body.stages[0].approvers).toEqual([
      { type: 'permission', action: 'update' },
    ]);
  });

  it('refuses to save while a JSON field holds text that does not parse', async () => {
    const { api, user } = await open();
    await user.click(
      screen.getByRole('switch', { name: 'Only when a condition holds' }),
    );
    const condition = await screen.findByRole('group', { name: 'Condition' });
    await user.click(
      within(condition).getByRole('combobox', { name: 'Condition' }),
    );
    await user.click(await screen.findByRole('option', { name: 'A range' }));
    const range = within(condition).getByLabelText('range');
    await user.click(range);
    await user.paste('[1,');
    expect(await within(condition).findByText('Not valid JSON.')).toBeVisible();
    // The error is the input's accessible description (aria-describedby).
    expect(range).toBeInvalid();
    expect(range).toHaveAccessibleDescription('Not valid JSON.');
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeDisabled();

    await user.clear(range);
    await user.click(range);
    await user.paste('[1,2]');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save policy' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    await findToast('Policy saved.');
    expect(api.puts[0]!.body.when).toEqual({ type: 'between', range: [1, 2] });
  });

  it('describes a JSON field by its hint', async () => {
    const { user } = await open();
    await user.click(
      screen.getByRole('switch', { name: 'Only when a condition holds' }),
    );
    const condition = await screen.findByRole('group', { name: 'Condition' });
    expect(
      within(condition).getByLabelText('Value'),
    ).toHaveAccessibleDescription(/^A number, text or true\/false/);
  });

  it('removes the condition when it is switched off', async () => {
    const { api, user } = await open({
      policy: view({
        policy: policyOf({
          when: { type: 'payload', path: 'amount', op: 'gt', value: 5 },
        }),
      }),
    });
    expect(screen.getByRole('group', { name: 'Condition' })).toBeVisible();
    await user.click(
      screen.getByRole('switch', { name: 'Only when a condition holds' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    await findToast('Policy saved.');
    expect(api.puts[0]!.body).not.toHaveProperty('when');
  });

  it('escalates an overdue stage to other approvers', async () => {
    const { api, user } = await open();
    const stage1 = screen.getByRole('region', { name: 'Stage 1' });
    await user.type(within(stage1).getByLabelText('Overdue after'), '3d');
    await user.click(
      within(stage1).getByRole('combobox', { name: 'When overdue' }),
    );
    await user.click(await screen.findByRole('option', { name: 'Escalate' }));
    const escalation = within(stage1).getByRole('group', {
      name: 'Escalation approver 1',
    });
    await user.type(within(escalation).getByLabelText('Role'), 'admin');
    await user.type(
      within(stage1).getByLabelText('Expire after escalating, after'),
      '2d',
    );
    await user.click(screen.getByRole('button', { name: 'Save policy' }));

    await findToast('Policy saved.');
    expect(api.puts[0]!.body.stages[0]).toMatchObject({
      dueAfter: '3d',
      onOverdue: 'escalate',
      escalateTo: [{ type: 'role', role: 'admin' }],
      escalationDueAfter: '2d',
    });
  });

  it('switches the action off and changes the resubmission period', async () => {
    const { api, user } = await open();
    await user.click(screen.getByRole('switch', { name: 'Needs approval' }));
    await user.clear(screen.getByLabelText('Time to resubmit'));
    await user.type(screen.getByLabelText('Time to resubmit'), '1w');
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    await findToast('Policy saved.');
    expect(api.puts[0]!.body).toMatchObject({
      enabled: false,
      resubmitWithin: '1w',
    });
  });

  it('shows what the API refuses, at the stage it names', async () => {
    const { user } = await open();
    server.use(
      http.put('/v1/approvals/policies/:key', () =>
        problem(400, 'validation_failed', {
          errors: [
            { path: 'stages.0.approvers.0.role', message: 'Too small' },
            { path: 'resubmitWithin', message: 'a duration' },
          ],
        }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    const stage1 = screen.getByRole('region', { name: 'Stage 1' });
    expect(await within(stage1).findByText(/Too small/)).toBeVisible();
    expect(within(stage1).getByText('approvers.0.role')).toBeVisible();
    expect(screen.getByText(/a duration/)).toBeVisible();
  });

  it("keeps the user's edits when the tab is back and another admin saved", async () => {
    const { api, user } = await open();
    const name = () =>
      within(screen.getByRole('region', { name: 'Stage 1' })).getByLabelText(
        'Name',
      );
    await user.clear(name());
    await user.type(name(), 'Mine');

    // Another admin saved meanwhile (a new version, a new ETag); the user
    // comes back to this tab. A refetch would remount the form and drop the
    // edits silently: the save's 412 is how a conflict is said instead.
    api.policy = view({ version: 1, source: 'override' });
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    focusManager.setFocused(undefined);

    expect(name()).toHaveValue('Mine');
  });

  it('says so when the policy changed since it was read (412)', async () => {
    const { user } = await open();
    server.use(
      http.put('/v1/approvals/policies/:key', () =>
        problem(412, 'precondition_failed'),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(await screen.findByText('This policy changed')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeDisabled();
  });

  it('reverts a customized policy to the default, with the ETag it read', async () => {
    const { api, user } = await open({
      policy: view({
        version: 2,
        source: 'override',
        policy: policyOf({ stages: [stage({ name: 'Mine' })] }),
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reset' }));
    await findToast('Policy reset.');
    expect(api.deletes).toEqual([{ ifMatch: '"v2"' }]);
    expect(await screen.findByText('Default')).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Stage 1' })).getByLabelText(
        'Name',
      ),
    ).toHaveValue('Editor review');
  });

  it('offers no reset for a policy still at the code default', async () => {
    await open();
    expect(
      screen.getByRole('button', { name: 'Reset to default' }),
    ).toBeDisabled();
  });

  it('shows a not-found state', async () => {
    mockPoliciesApi();
    server.use(
      http.get('/v1/approvals/policies/:key', () => problem(404, 'not_found')),
    );
    await renderApp('/approval-policies/Nope.nothing');
    expect(await screen.findByText('Policy not found')).toBeVisible();
    // The page says it: not a toast as well.
    await expectNoToast();
  });
});
