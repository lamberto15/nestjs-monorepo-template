import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoPermissions } from '../demo/demo.jobs.js';
import { FEATURES } from '../features/index.js';
import {
  ACCESS_PERMISSIONS,
  i18nSegment,
} from '../iam/access/permission-catalog.js';
import type { PermissionsDefinition } from '../iam/access/permissions.js';
import { PLATFORM_PERMISSIONS } from '../platform/ops/ops.policy.js';

type Catalog = { [key: string]: string | Catalog };

/**
 * Every declared text of the access catalog (GET /v1/access/catalog), by
 * its `permissions.<key>` (PermissionCatalog.view()): what the English
 * catalog must say, as the declarations do.
 */
function declaredTexts(definitions: PermissionsDefinition[]) {
  const texts = new Map<string, string>();
  const put = (key: string[], text: string) =>
    texts.set(key.map(i18nSegment).join('.'), text);
  for (const definition of definitions) {
    for (const [subject, declared] of Object.entries(definition.subjects)) {
      const own = ['subjects', subject];
      put([...own, 'label'], declared.label);
      for (const [action, details] of Object.entries(declared.actions)) {
        put([...own, 'actions', action], details.label);
      }
      for (const [field, details] of Object.entries(declared.fields ?? {})) {
        put([...own, 'fields', field], details.label);
      }
      for (const [key, template] of Object.entries(declared.conditions)) {
        const at = template.translation
          ? ['conditions', template.translation]
          : [...own, 'conditions', key];
        put([...at, 'label'], template.label);
        put([...at, 'description'], template.description);
        if (template.paramsInput) {
          put([...at, 'input'], template.paramsInput.label);
        }
      }
    }
    for (const job of definition.systemJobs ?? []) {
      put(['systemJobs', job.key, 'label'], job.label);
      put(['systemJobs', job.key, 'description'], job.description);
    }
  }
  return texts;
}

function flatten(catalog: Catalog, prefix = ''): Map<string, string> {
  const found = new Map<string, string>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      found.set(path, value);
    } else {
      for (const [inner, text] of flatten(value, path)) {
        found.set(inner, text);
      }
    }
  }
  return found;
}

describe('the permissions catalog (i18n)', () => {
  const declared = declaredTexts([
    ACCESS_PERMISSIONS,
    PLATFORM_PERMISSIONS,
    ...FEATURES.map((feature) => feature.permissions),
    demoPermissions(FEATURES),
  ]);
  const english = flatten(
    JSON.parse(
      readFileSync(join(import.meta.dirname, 'en', 'permissions.json'), 'utf8'),
    ) as Catalog,
  );

  it('says in English what the declarations say', () => {
    for (const [key, text] of english) {
      expect({ key, text }).toEqual({ key, text: declared.get(key) });
    }
  });

  it('has every text the template ships with', () => {
    // A generated feature's own may be left out (its declared English shows).
    const shipped = [...declared.keys()].filter(
      (key) =>
        !key.startsWith('subjects.') ||
        ['Access', 'Approval', 'Ops', 'MailSuppression', 'Note'].includes(
          key.split('.')[1]!,
        ),
    );
    expect(shipped.filter((key) => !english.has(key))).toEqual([]);
  });
});
