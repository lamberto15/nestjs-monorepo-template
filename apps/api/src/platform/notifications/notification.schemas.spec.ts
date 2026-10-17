import {
  channelSettingsInputSchema,
  channelSettingsSchema,
  preferencesInputSchema,
  preferencesViewSchema,
} from './notification.schemas.js';

describe('the typed notification settings', () => {
  it('takes the values the channels take', () => {
    for (const email of [false, 'immediate', 'hourly', 'daily']) {
      expect(channelSettingsSchema.safeParse({ email }).success).toBe(true);
    }
    expect(channelSettingsSchema.safeParse({ webhook: true }).success).toBe(
      true,
    );
    expect(channelSettingsSchema.safeParse({}).success).toBe(true);
  });

  it('refuses any other value, naming the channel', () => {
    for (const email of ['often', true, 1, null]) {
      const result = preferencesInputSchema.safeParse({
        'note.published': { email },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([
        ['note.published', 'email'],
      ]);
    }
    expect(
      channelSettingsInputSchema.safeParse({ webhook: 'yes' }).success,
    ).toBe(false);
  });

  it('lets an unknown channel through the body, for the service to refuse by name', () => {
    expect(
      preferencesInputSchema.parse({ 'note.published': { sms: true } }),
    ).toEqual({ 'note.published': { sms: true } });
  });

  it('describes what the service returns', () => {
    expect(
      preferencesViewSchema.safeParse({
        types: { 'note.published': { email: 'daily' } },
      }).success,
    ).toBe(true);
  });
});
