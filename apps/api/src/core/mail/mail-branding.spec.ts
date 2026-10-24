import { MailTemplateEngine } from '@nestjs/mail';
import {
  BrandedTemplateEngine,
  DEFAULT_MAIL_BRAND,
  withMailBrand,
} from './mail-branding.js';

class Spy extends MailTemplateEngine {
  contexts: object[] = [];
  render(_name: string, context: object) {
    this.contexts.push(context);
    return { html: '' };
  }
}

describe('BrandedTemplateEngine', () => {
  it('gives the templates the brand of the work in scope, else the default', async () => {
    const spy = new Spy();
    const engine = new BrandedTemplateEngine(spy);
    await engine.render('x', { a: 1 }, { locale: 'en' });
    const brand = { name: 'Acme', color: '#0a84ff', logoUrl: null };
    await withMailBrand(brand, async () => {
      await engine.render('x', { a: 2 }, { locale: 'en' });
    });
    expect(spy.contexts).toEqual([
      { brand: DEFAULT_MAIL_BRAND, a: 1, layoutLang: 'en' },
      { brand, a: 2, layoutLang: 'en' },
    ]);
  });

  it('lets the mail’s own context win', async () => {
    const spy = new Spy();
    await new BrandedTemplateEngine(spy).render(
      'x',
      { brand: 'own' },
      { locale: 'en' },
    );
    expect(spy.contexts).toEqual([{ brand: 'own', layoutLang: 'en' }]);
  });
});
