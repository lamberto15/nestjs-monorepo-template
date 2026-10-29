import { RequestMethod } from '@nestjs/common';
import { field } from '../fields/field.js';
import { defineRecord, duplicateRules } from './record.js';
import { actionPath, recordApprovalActions } from './record-approvals.js';
import { recordApprovalRoutes } from './record-approval-routes.js';
import { recordSetting, recordSettings } from './record-settings.js';
import { computed, hideComputed, withComputed } from './record-computed.js';

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
    // Data-quality checks name the record's own fields.
    expect(() =>
      defineRecord({ ...base, quality: { duplicates: ['email'] } }),
    ).toThrow(/quality names "email"/);
    expect(() =>
      defineRecord({ ...base, quality: { recommended: ['title'] } }),
    ).not.toThrow();
  });

  it('finds duplicates by its declared rules, else its title field; merge needs a recycle bin', () => {
    const base = {
      subject: 'Contact',
      path: 'contacts',
      apiTag: 'contacts',
      className: 'ContactSpec',
      noun: 'contact',
      table: 'contacts',
      softDelete: true,
      unit: false,
      fields: { name: field.string(), email: field.string().optional() },
      capabilities: ['merge'] as const,
    };
    expect(duplicateRules(defineRecord(base))).toEqual([['name']]);
    expect(
      duplicateRules(defineRecord({ ...base, duplicates: [['email']] })),
    ).toEqual([['email']]);
    expect(() => defineRecord({ ...base, softDelete: false })).toThrow(
      /needs softDelete/,
    );
    expect(() => defineRecord({ ...base, duplicates: [['phone']] })).toThrow(
      /can't match by "phone"/,
    );
  });

  it('computes its computed fields on read, each after those it reads, hidden with what they read', () => {
    const LINE = defineRecord({
      subject: 'Line',
      path: 'lines',
      apiTag: 'lines',
      className: 'LineSpec',
      noun: 'line',
      table: 'lines',
      softDelete: false,
      unit: false,
      fields: {
        quantity: field.int(),
        unitPrice: field.money(),
        note: field.string().optional(),
      },
      // Declared before what it reads: computed in the order they need.
      computed: {
        withTax: computed.money('total * 1.19'),
        total: computed.money('quantity * unitPrice'),
        perUnit: computed.decimal('quantity'),
        labelled: computed.string("coalesce(note, 'none')"),
      },
      capabilities: [],
    });
    const views = [
      {
        quantity: 2,
        unitPrice: { amount: '10.00', currency: 'EUR' },
        note: null,
      },
    ];
    const [line] = withComputed(LINE, views);
    expect(line).toMatchObject({
      total: { amount: '20.00', currency: 'EUR' },
      withTax: { amount: '23.80', currency: 'EUR' },
      perUnit: '2',
      labelled: 'none',
    });
    // A reader who may not see the price sees neither total, nor what reads it.
    const { unitPrice: _hidden, ...redacted } = line!;
    const [shown] = hideComputed(LINE, [line!], [redacted]);
    expect(shown).not.toHaveProperty('total');
    expect(shown).not.toHaveProperty('withTax');
    expect(shown).toMatchObject({ perUnit: '2', labelled: 'none' });
  });

  it('refuses computed fields that cycle, mistype, read what is not there or take a name', () => {
    const base = {
      subject: 'Cost',
      path: 'costs',
      apiTag: 'costs',
      className: 'CostSpec',
      noun: 'cost',
      table: 'costs',
      softDelete: false,
      unit: false,
      fields: { amount: field.int(), extra: field.json().optional() },
      capabilities: [],
    } as const;
    expect(() =>
      defineRecord({
        ...base,
        computed: { a: computed.int('b + 1'), b: computed.int('a + amount') },
      }),
    ).toThrow(/cycle: a → b → a/);
    expect(() =>
      defineRecord({ ...base, computed: { a: computed.int('a') } }),
    ).toThrow(/cycle/);
    expect(() =>
      defineRecord({ ...base, computed: { a: computed.string('amount') } }),
    ).toThrow(/is declared string, but `amount` is int/);
    expect(() =>
      defineRecord({
        ...base,
        computed: { a: computed.string('text(extra)') },
      }),
    ).toThrow(/Nothing is named "extra"/);
    expect(() =>
      defineRecord({ ...base, computed: { amount: computed.int('1') } }),
    ).toThrow(/takes a name the record already shows/);
    expect(() =>
      defineRecord({
        ...base,
        computed: { a: computed.int('process.exit()') },
      }),
    ).toThrow(/Unexpected "\."/);
  });
});
