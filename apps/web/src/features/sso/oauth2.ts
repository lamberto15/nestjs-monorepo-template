import type { Connection } from './queries';

/** The auth methods of a token endpoint (RFC 6749 and `none`, a public client). */
export const AUTH_METHODS = [
  'client_secret_basic',
  'client_secret_post',
  'none',
] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export type EmailTrust = 'never' | 'field' | 'verified-domains';
export type PresetChoice = 'custom' | 'lark' | 'feishu';

/** The OAuth 2.0 part of the dialog's form (flat: the API names the fields). */
export type OAuth2Values = {
  preset: PresetChoice;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  tokenEndpointAuthMethod: AuthMethod;
  scopes: string[];
  mappingRoot: string;
  mappingSubject: string;
  mappingEmail: string;
  mappingName: string;
  mappingPicture: string;
  mappingGroups: string;
  mappingErrorCode: string;
  emailTrust: EmailTrust;
  emailVerifiedPath: string;
};

export const emptyOAuth2: OAuth2Values = {
  preset: 'custom',
  authorizationEndpoint: '',
  tokenEndpoint: '',
  userinfoEndpoint: '',
  tokenEndpointAuthMethod: 'client_secret_basic',
  scopes: [],
  mappingRoot: '',
  mappingSubject: '',
  mappingEmail: '',
  mappingName: '',
  mappingPicture: '',
  mappingGroups: '',
  mappingErrorCode: '',
  emailTrust: 'never',
  emailVerifiedPath: '',
};

/**
 * What the Lark and Feishu presets fill in (docs/auth.md, "Lark/Feishu (v2)").
 * The API fills the same defaults when a request names the preset; they are
 * shown here so the administrator sees and can edit them before saving.
 */
const larkLike = (accounts: string, open: string): Partial<OAuth2Values> => ({
  authorizationEndpoint: `https://${accounts}/open-apis/authen/v1/authorize`,
  tokenEndpoint: `https://${open}/open-apis/authen/v2/oauth/token`,
  userinfoEndpoint: `https://${open}/open-apis/authen/v1/user_info`,
  tokenEndpointAuthMethod: 'client_secret_post',
  mappingRoot: 'data',
  mappingSubject: 'open_id',
  mappingEmail: 'enterprise_email',
  mappingName: 'name',
  mappingPicture: 'avatar_url',
  mappingErrorCode: 'code',
  emailTrust: 'verified-domains',
});

export const PRESETS: Record<PresetChoice, Partial<OAuth2Values>> = {
  custom: {},
  lark: larkLike('accounts.larksuite.com', 'open.larksuite.com'),
  feishu: larkLike('accounts.feishu.cn', 'open.feishu.cn'),
};

/** The form's OAuth 2.0 values for a preset: its fields over the empty form. */
export function presetValues(preset: PresetChoice): OAuth2Values {
  return { ...emptyOAuth2, ...PRESETS[preset], preset };
}

/** The form's OAuth 2.0 values of an existing connection. */
export function valuesOf(connection?: Connection): OAuth2Values {
  const o = connection?.oauth2;
  if (!o) return emptyOAuth2;
  const { mapping } = o;
  const verified = mapping.emailVerified;
  return {
    preset: 'custom',
    authorizationEndpoint: o.authorizationEndpoint,
    tokenEndpoint: o.tokenEndpoint,
    userinfoEndpoint: o.userinfoEndpoint,
    tokenEndpointAuthMethod: o.tokenEndpointAuthMethod,
    scopes: o.scopes,
    mappingRoot: mapping.root ?? '',
    mappingSubject: mapping.subject,
    mappingEmail: mapping.email ?? '',
    mappingName: mapping.name ?? '',
    mappingPicture: mapping.picture ?? '',
    mappingGroups: mapping.groups ?? '',
    mappingErrorCode: mapping.errorCode ?? '',
    emailTrust:
      typeof verified === 'object'
        ? 'field'
        : verified === 'never'
          ? 'never'
          : 'verified-domains',
    emailVerifiedPath: typeof verified === 'object' ? verified.path : '',
  };
}

/** The `mapping` the API takes: the paths filled in, nothing else. */
export function mappingOf(v: OAuth2Values) {
  const optional = (value: string) => value.trim() || undefined;
  return {
    root: optional(v.mappingRoot),
    subject: v.mappingSubject.trim(),
    email: optional(v.mappingEmail),
    name: optional(v.mappingName),
    picture: optional(v.mappingPicture),
    groups: optional(v.mappingGroups),
    errorCode: optional(v.mappingErrorCode),
    emailVerified:
      v.emailTrust === 'field'
        ? { path: v.emailVerifiedPath.trim() }
        : v.emailTrust,
  };
}

/** The API's `mapping.<path>` errors, on the form's flat field names. */
export const MAPPING_ERROR_FIELDS: Record<string, string> = {
  'mapping.root': 'mappingRoot',
  'mapping.subject': 'mappingSubject',
  'mapping.email': 'mappingEmail',
  'mapping.name': 'mappingName',
  'mapping.picture': 'mappingPicture',
  'mapping.groups': 'mappingGroups',
  'mapping.errorCode': 'mappingErrorCode',
  'mapping.emailVerified': 'emailVerifiedPath',
  'mapping.emailVerified.path': 'emailVerifiedPath',
};
