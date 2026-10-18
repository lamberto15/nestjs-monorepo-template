import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoPermissions } from '../demo/demo.jobs.js';
import { FEATURES } from '../features/index.js';
import {
  ACCESS_PERMISSIONS,
  conditionTextKeys,
  i18nSegment,
  jobTextKeys,
  subjectTextKey,
} from '../iam/access/permission-catalog.js';
import type { PermissionsDefinition } from '../iam/access/permissions.js';
import { PLATFORM_PERMISSIONS } from '../platform/ops/ops.policy.js';

type Catalog = { [key: string]: string | Catalog };

/**
 * Every declared text of the access catalog (GET /v1/access/catalog), with
 * the keys it may be found at (PermissionCatalog.view()): what the English
 * catalog must say, as the declarations do.
 */
function declaredTexts(definitions: PermissionsDefinition[]) {
  const texts: { keys: string[]; text: string; subject?: string }[] = [];
  const put = (keys: string[][], text: string, subject?: string) =>
    texts.push({
      keys: keys.map((key) => key.map(i18nSegment).join('.')),
      text,
      subject,
    });
  for (const definition of definitions) {
    const subjects = Object.keys(definition.subjects);
    for (const [subject, declared] of Object.entries(definition.subjects)) {
      const own = subjectTextKey(subject);
      put([[own, 'label']], declared.label, subject);
      for (const [action, details] of Object.entries(declared.actions)) {
        put([[own, 'actions', action]], details.label, subject);
      }
      for (const [field, details] of Object.entries(declared.fields ?? {})) {
        put([[own, 'fields', field]], details.label, subject);
      }
      for (const [key, template] of Object.entries(declared.conditions)) {
        const at = (part: string) =>
          conditionTextKeys(subject, key, template, part);
        put(at('label'), template.label, subject);
        put(at('description'), template.description, subject);
        if (template.paramsInput) {
          put(at('input'), template.paramsInput.label, subject);
        }
      }
    }
    for (const job of definition.systemJobs ?? []) {
      put(jobTextKeys(job.key, subjects, 'label'), job.label, subjects[0]);
      put(
        jobTextKeys(job.key, subjects, 'description'),
        job.description,
        subjects[0],
      );
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
    const byKey = new Map(
      declared.flatMap(({ keys, text }) => keys.map((key) => [key, text])),
    );
    for (const [key, text] of english) {
      expect({ key, text }).toEqual({ key, text: byKey.get(key) });
    }
  });

  it('has every text the template ships with', () => {
    // A generated feature's own may be left out (its declared English shows).
    const shipped = declared.filter(
      ({ subject }) =>
        !subject ||
        ['Access', 'Approval', 'Ops', 'MailSuppression', 'Note'].includes(
          subject,
        ),
    );
    expect(
      shipped
        .filter(({ keys }) => !keys.some((key) => english.has(key)))
        .map(({ keys }) => keys[0]),
    ).toEqual([]);
  });
});
