import {
  endpointProblem,
  mapUserinfo,
  type Oauth2Mapping,
  oauth2MappingSchema,
  presetDefaults,
  valueAt,
} from './oauth2-mapping.js';
import { SsoRefused } from './sso-accounts.service.js';

/** The reason `work` was refused with, or a failure when it wasn't. */
function refusal(work: () => unknown) {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SsoRefused);
    return (error as SsoRefused).reason;
  }
  throw new Error('not refused');
}

const lark = presetDefaults({ name: 'lark', region: 'lark' }).mapping;

/** A Lark `user_info` answer (its documented shape). */
const larkAnswer = (data: Record<string, unknown> = {}, code = 0) => ({
  code,
  msg: 'success',
  data: {
    open_id: 'ou_3f1c',
    union_id: 'on_99a2',
    user_id: 'u_17',
    tenant_key: 'tk_1',
    name: 'Ada Lovelace',
    avatar_url: 'https://example.com/a.png',
    email: 'ada@personal.test',
    enterprise_email: 'ada@acme.test',
    ...data,
  },
});

describe('OAuth 2.0 mapping', () => {
  describe('valueAt', () => {
    it('follows dot paths through objects and array indexes', () => {
      const source = { a: { b: [{ c: 1 }, { c: 2 }] } };
      expect(valueAt(source, 'a.b.1.c')).toBe(2);
      expect(valueAt(source, 'a.x.c')).toBeUndefined();
      expect(valueAt(source, 'a.b.c')).toBeUndefined();
    });

    it('reads own fields only, never the prototype', () => {
      expect(valueAt({}, 'constructor')).toBeUndefined();
      expect(valueAt({}, 'toString')).toBeUndefined();
      expect(valueAt({ a: {} }, 'a.__proto__')).toBeUndefined();
    });
  });

  describe('the schema', () => {
    it('defaults emailVerified to never', () => {
      expect(oauth2MappingSchema.parse({ subject: 'id' }).emailVerified).toBe(
        'never',
      );
    });

    it('refuses prototype segments, odd paths and unknown keys', () => {
      for (const subject of ['__proto__', 'a.constructor', 'a..b', 'a b']) {
        expect(oauth2MappingSchema.safeParse({ subject }).success).toBe(false);
      }
      expect(
        oauth2MappingSchema.safeParse({ subject: 'id', other: 'x' }).success,
      ).toBe(false);
      expect(
        oauth2MappingSchema.safeParse({
          subject: 'id',
          emailVerified: 'always',
        }).success,
      ).toBe(false);
    });
  });

  describe('mapUserinfo', () => {
    it('maps a Lark answer: root, subject, enterprise address, domain trust', () => {
      expect(mapUserinfo(larkAnswer(), lark)).toEqual({
        subject: 'ou_3f1c',
        email: 'ada@acme.test',
        emailVerified: true,
        name: 'Ada Lovelace',
        picture: 'https://example.com/a.png',
        groups: undefined,
      });
    });

    it('never takes the personal address for the enterprise one', () => {
      const user = mapUserinfo(
        larkAnswer({ enterprise_email: undefined }),
        lark,
      );
      expect(user.email).toBeUndefined();
    });

    it('refuses a failed answer (errorCode non-zero or truthy)', () => {
      expect(refusal(() => mapUserinfo(larkAnswer({}, 99991663), lark))).toBe(
        'userinfo_error:99991663',
      );
      expect(
        refusal(() =>
          mapUserinfo({ error: 'invalid_token', id: 1 }, {
            subject: 'id',
            errorCode: 'error',
            emailVerified: 'never',
          } satisfies Oauth2Mapping),
        ),
      ).toBe('userinfo_error:invalid_token');
      // Absent, zero or false: no failure.
      const mapping: Oauth2Mapping = {
        subject: 'id',
        errorCode: 'code',
        emailVerified: 'never',
      };
      expect(mapUserinfo({ id: 'x' }, mapping).subject).toBe('x');
      expect(mapUserinfo({ id: 'x', code: false }, mapping).subject).toBe('x');
    });

    it('turns a number subject into a string', () => {
      const user = mapUserinfo(
        { id: 583231, login: 'octo' },
        { subject: 'id', emailVerified: 'never' },
      );
      expect(user.subject).toBe('583231');
    });

    it('refuses a missing, empty or malformed subject', () => {
      const mapping: Oauth2Mapping = { subject: 'id', emailVerified: 'never' };
      expect(refusal(() => mapUserinfo({}, mapping))).toBe('no_stable_subject');
      expect(refusal(() => mapUserinfo({ id: '  ' }, mapping))).toBe(
        'no_stable_subject',
      );
      expect(refusal(() => mapUserinfo({ id: null }, mapping))).toBe(
        'no_stable_subject',
      );
      for (const id of [{}, ['a'], true, Number.NaN, 'x'.repeat(513)]) {
        expect(refusal(() => mapUserinfo({ id }, mapping))).toBe(
          'userinfo_malformed',
        );
      }
    });

    it('refuses an answer that is no object, or no user object at root', () => {
      for (const body of [null, 'text', [1], 42]) {
        expect(refusal(() => mapUserinfo(body, lark))).toBe(
          'userinfo_malformed',
        );
      }
      expect(
        refusal(() => mapUserinfo({ code: 0, data: 'nobody' }, lark)),
      ).toBe('userinfo_malformed');
    });

    it('reads emailVerified in its three modes', () => {
      const base = { subject: 'id', email: 'mail' } as const;
      const body = { id: 1, mail: 'a@acme.test', checked: true, text: 'true' };
      expect(
        mapUserinfo(body, { ...base, emailVerified: 'never' }).emailVerified,
      ).toBe(false);
      expect(
        mapUserinfo(body, { ...base, emailVerified: 'verified-domains' })
          .emailVerified,
      ).toBe(true);
      expect(
        mapUserinfo(body, { ...base, emailVerified: { path: 'checked' } })
          .emailVerified,
      ).toBe(true);
      // Only a boolean true: a string "true" is no verification.
      expect(
        mapUserinfo(body, { ...base, emailVerified: { path: 'text' } })
          .emailVerified,
      ).toBe(false);
      expect(
        mapUserinfo(body, { ...base, emailVerified: { path: 'missing' } })
          .emailVerified,
      ).toBe(false);
    });

    it('reads groups only from an array of strings', () => {
      const mapping: Oauth2Mapping = {
        subject: 'id',
        groups: 'teams',
        emailVerified: 'never',
      };
      expect(
        mapUserinfo({ id: 1, teams: ['eng', 7, ' ops ', ''] }, mapping).groups,
      ).toEqual(['eng', 'ops']);
      expect(
        mapUserinfo({ id: 1, teams: 'eng' }, mapping).groups,
      ).toBeUndefined();
      expect(mapUserinfo({ id: 1 }, mapping).groups).toBeUndefined();
    });
  });

  describe('the Lark preset', () => {
    it('fills the endpoints of each region and posts the client secret', () => {
      expect(presetDefaults({ name: 'lark', region: 'lark' })).toMatchObject({
        authorizationEndpoint:
          'https://accounts.larksuite.com/open-apis/authen/v1/authorize',
        tokenEndpoint:
          'https://open.larksuite.com/open-apis/authen/v2/oauth/token',
        userinfoEndpoint:
          'https://open.larksuite.com/open-apis/authen/v1/user_info',
        tokenEndpointAuthMethod: 'client_secret_post',
      });
      expect(presetDefaults({ name: 'lark', region: 'feishu' })).toMatchObject({
        authorizationEndpoint:
          'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
        tokenEndpoint: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
        userinfoEndpoint:
          'https://open.feishu.cn/open-apis/authen/v1/user_info',
      });
      expect(oauth2MappingSchema.parse(lark)).toEqual(lark);
    });
  });

  describe('endpointProblem', () => {
    it('accepts https on a public host', () => {
      expect(endpointProblem('https://open.larksuite.com/x', false)).toBe(
        undefined,
      );
      expect(endpointProblem('https://8.8.8.8/token', false)).toBeUndefined();
    });

    it('refuses http, credentials and what is no URL', () => {
      expect(endpointProblem('http://idp.example.com/token', false)).toMatch(
        /https/,
      );
      expect(endpointProblem('http://idp.example.com/token', true)).toMatch(
        /https/,
      );
      expect(endpointProblem('https://u:p@idp.example.com/', false)).toMatch(
        /password/,
      );
      expect(endpointProblem('not a url', false)).toBe('Not a URL.');
    });

    it('allows loopback (http too) only with the flag', () => {
      for (const url of [
        'http://127.0.0.1:4000/token',
        'http://localhost:4000/token',
        'https://[::1]/token',
      ]) {
        expect(endpointProblem(url, false)).toMatch(/loopback/);
        expect(endpointProblem(url, true)).toBeUndefined();
      }
    });

    it('refuses private, link-local and metadata addresses, flag or not', () => {
      for (const url of [
        'https://169.254.169.254/latest/meta-data',
        'https://10.0.0.1/token',
        'https://192.168.1.10/token',
        'https://[fd00:ec2::254]/token',
        'https://100.100.100.200/token',
        'https://[::ffff:169.254.169.254]/token',
      ]) {
        expect(endpointProblem(url, true)).toMatch(/refused/);
        expect(endpointProblem(url, false)).toMatch(/refused/);
      }
    });
  });
});
