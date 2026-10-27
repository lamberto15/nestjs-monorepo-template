import { RequestMethod } from '@nestjs/common';
import { field } from '../fields/field.js';
import { defineRecord } from './record.js';
import { actionPath, recordApprovalActions } from './record-approvals.js';
import { recordApprovalRoutes } from './record-approval-routes.js';
import { recordSetting, recordSettings } from './record-settings.js';

const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

const INVOICE = defineRecord({
  subject: 'Invoice',
  path: 'invoice-lines',
  apiTag: 'invoice-lines',
  className: 'InvoiceLineSpec',
  noun: 'invoice line',
  table: 'invoice_lines',
  softDelete: true,
  unit: false,
  fields: { title: field.string() },
  approvals: {
    publish: { label: 'Publish an invoice line' },
    markPaid: { label: 'Mark an invoice line paid', flag: false },
  },
  settings: {
    paymentDays: recordSetting.int(30).min(1).max(365),
    autoSend: recordSetting.flag(),
    tone: recordSetting
      .enum(['formal', 'casual'], 'formal')
      .scopes(['tenant', 'user']),
    footer: recordSetting.string('').hidden(),
  },
  capabilities: [],
});

/** The settings and approvals a record declares (record-settings.ts, record-approvals.ts). */
describe('a record declaration', () => {
  it('declares its settings under <path in camelCase>.<name>, each of its kind', () => {
    const settings = recordSettings(INVOICE);
    expect(settings.paymentDays).toMatchObject({
      key: 'invoiceLines.paymentDays',
      label: 'Payment days',
      default: 30,
    });
    expect(settings.paymentDays.schema.safeParse(0).success).toBe(false);
    expect(settings.paymentDays.schema.safeParse(366).success).toBe(false);
    expect(settings.paymentDays.schema.safeParse(1.5).success).toBe(false);
    expect(settings.paymentDays.schema.safeParse(60).success).toBe(true);
    expect(settings.autoSend).toMatchObject({ flag: true, default: false });
    expect(settings.tone.scopes).toEqual(['tenant', 'user']);
    expect(settings.tone.schema.safeParse('casual').success).toBe(true);
    expect(settings.tone.schema.safeParse('loud').success).toBe(false);
    expect(settings.footer.public).toBe(false);
    // The same objects every call: the platform registers them by key.
    expect(recordSettings(INVOICE)).toBe(settings);
  });

  it('declares each approvable action, with the flag that switches it on', () => {
    const [publish, markPaid] = recordApprovalActions(INVOICE);
    expect(publish!.declaration).toMatchObject({
      subject: 'Invoice',
      action: 'publish',
      label: 'Publish an invoice line',
    });
    expect(publish!.flag).toMatchObject({
      key: 'invoiceLines.publishApproval',
      default: false,
      // Never per user: a requester could switch their own approval off.
      scopes: ['tenant', 'unit'],
    });
    expect(publish!.declaration.setting).toBe(publish!.flag);
    // `flag: false`: always needs approval.
    expect(markPaid!.flag).toBeNull();
    expect(markPaid!.declaration.setting).toBeUndefined();
    expect(publish!.declaration.policy.stages[0]).toMatchObject({
      approvers: [{ type: 'permission', action: 'update' }],
    });
  });

  it('routes each action at POST /<path>/{id}/<action in kebab-case>', () => {
    expect(actionPath('markPaid')).toBe('mark-paid');
    const routes = recordApprovalRoutes(INVOICE, {
      policy: class {} as never,
      effects: {},
    });
    expect(routes.map((route) => route.name)).toEqual([
      'InvoiceLineSpecPublishController',
      'InvoiceLineSpecMarkPaidController',
    ]);
    const paths = routes.map((route) => {
      const handler = route.prototype.request as object;
      return [
        Reflect.getMetadata(PATH_METADATA, route),
        Reflect.getMetadata(PATH_METADATA, handler),
        Reflect.getMetadata(METHOD_METADATA, handler),
      ];
    });
    expect(paths).toEqual([
      ['invoice-lines', ':id/publish', RequestMethod.POST],
      ['invoice-lines', ':id/mark-paid', RequestMethod.POST],
    ]);
  });

  it('refuses an action the record already routes, and a setting that is the approval flag', () => {
    const base = {
      subject: 'Bill',
      path: 'bills',
      apiTag: 'bills',
      className: 'BillSpec',
      noun: 'bill',
      table: 'bills',
      softDelete: false,
      unit: false,
      fields: { title: field.string() },
      capabilities: [],
    } as const;
    expect(() =>
      defineRecord({ ...base, approvals: { restore: { label: 'x' } } }),
    ).toThrow(/can't be an approval's action/);
    expect(() =>
      defineRecord({ ...base, approvals: { 'not valid': { label: 'x' } } }),
    ).toThrow(/can't be an approval's action/);
    expect(() =>
      defineRecord({
        ...base,
        approvals: { pay: { label: 'x' } },
        settings: { payApproval: recordSetting.flag() },
      }),
    ).toThrow(/can't be a setting's name/);
  });
});
