// What `--with …` means to the generator (tools/feature/add.mjs): the
// capabilities' names, the texts they need in every locale, and the tests
// the generated e2e spec gets. The capabilities themselves are the
// platform's (platform/records: generic targets and routes), declared in
// the feature's `<item>.record.ts`.

import { pascalOf } from './fields.mjs';

export const CAPABILITIES = [
  'tags',
  'comments',
  'attachments',
  'revisions',
  'pdf',
  'bulk',
  'watch',
  'search',
  'transfer',
];

/** `--with tags,comments`: the capabilities, checked; pdf brings attachments (a PDF is one). */
export function parseCapabilities(list, fields) {
  const wanted = new Set(
    (list ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  for (const name of wanted) {
    if (!CAPABILITIES.includes(name)) {
      throw new Error(
        `--with: "${name}" is not a capability; any of ${CAPABILITIES.join(', ')}.`,
      );
    }
  }
  if (wanted.has('pdf')) {
    wanted.add('attachments');
  }
  if (wanted.has('search') && !textFields(fields).length) {
    throw new Error(
      '--with search: the feature needs a string or text field to search.',
    );
  }
  return wanted;
}

const textFields = (fields) =>
  fields.filter((f) => f.type === 'string' || f.type === 'text');
/** The field a record is called by (comments, search, PDF): its first string, if any. */
export const titleField = (fields) =>
  fields.find((f) => f.type === 'string') ?? null;
/** `invoiceLine`: notification types, i18n keys, audit actions. */
export const lowerFirst = (word) => word[0].toLowerCase() + word.slice(1);

/** The tests each capability adds to the generated e2e spec. */
export function e2eTests({ t, has, path, title }) {
  const tests = [];
  const make = `const id = (await create(node.admin()).expect(201)).body.id as string;`;
  if (has('tags')) {
    tests.push(
      `  it('takes tags, and lists by them', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    const tag = (await admin.post('/v1/tags').send({ subject: '${t.Singular}', name: 'Urgent' }).expect(201)).body.id as string;`,
      `    await admin.put(\`${path}/\${id}/tags\`).send({ tagIds: [tag] }).expect(200);`,
      `    expect((await admin.get(\`${path}/\${id}\`).expect(200)).body.tags).toEqual([expect.objectContaining({ id: tag })]);`,
      `    expect((await admin.get(\`${path}?tag=\${tag}\`).expect(200)).body.items.map((item: { id: string }) => item.id)).toEqual([id]);`,
      `  });`,
    );
  }
  if (has('comments')) {
    tests.push(
      `  it('takes comments', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    await admin.post(\`${path}/\${id}/comments\`).send({ body: 'Looks good.' }).expect(201);`,
      `    expect((await admin.get(\`${path}/\${id}/comments\`).expect(200)).body.items).toHaveLength(1);`,
      `  });`,
    );
  }
  if (has('attachments')) {
    tests.push(
      `  it('takes attachments', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    await admin.post(\`${path}/\${id}/attachments\`).attach('file', Buffer.from('Minutes.\\n'), { filename: 'minutes.txt', contentType: 'text/plain' }).expect(201);`,
      `    expect((await admin.get(\`${path}/\${id}/attachments\`).expect(200)).body.items).toHaveLength(1);`,
      `  });`,
    );
  }
  if (has('revisions')) {
    tests.push(
      `  it('keeps its revisions', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    await admin.patch(\`${path}/\${id}\`).send(changed).expect(200);`,
      `    const revisions = (await admin.get(\`${path}/\${id}/revisions\`).expect(200)).body.items;`,
      `    expect(revisions).toHaveLength(2);`,
      `    await admin.post(\`${path}/\${id}/revisions/1/restore\`).expect(200);`,
      `  });`,
    );
  }
  if (has('pdf')) {
    tests.push(
      `  it('asks for a PDF (unavailable without Gotenberg: GOTENBERG_URL)', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    const res = await admin.post(\`${path}/\${id}/pdf\`).set('Idempotency-Key', randomUUID()).expect(503);`,
      `    expect(res.body.code).toBe('documents_unavailable');`,
      `  });`,
    );
  }
  if (has('bulk')) {
    tests.push(
      `  it('deletes many at once', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    const res = await admin.post('${path}/bulk').set('Idempotency-Key', randomUUID()).send({ action: 'delete', ids: [id] }).expect(200);`,
      `    expect(res.body.done).toBe(1);`,
      `    await admin.get(\`${path}/\${id}\`).expect(404);`,
      `  });`,
    );
  }
  if (has('watch')) {
    tests.push(
      `  it('is watched, and unwatched', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    expect((await admin.post(\`${path}/\${id}/watch\`).expect(200)).body).toEqual({ watching: true });`,
      `    await admin.delete(\`${path}/\${id}/watch\`).expect(204);`,
      `  });`,
    );
  }
  if (has('search') && title) {
    tests.push(
      `  it('is found by its words', async () => {`,
      `    const admin = node.admin();`,
      `    ${make}`,
      `    const found = (await admin.get('${path}?q=${title.name}').expect(200)).body.items.map((item: { id: string }) => item.id);`,
      `    expect(found).toContain(id);`,
      `  });`,
    );
  }
  return tests;
}

/**
 * The texts the capabilities need, by namespace and key path (English; the
 * other locales get the same until translated: add.mjs lists them).
 */
export function texts({ t, fields, has }) {
  const lc = lowerFirst(t.Singular);
  const out = {};
  if (has('comments')) {
    out.notifications = {
      [lc]: {
        commented: {
          label: `Comment on ${t.aNoun} you watch`,
          title: 'New comment',
          body: {
            one: '{by} commented on "{title}": {excerpt}',
            other:
              '{count} new comments on "{title}"; the latest by {by}: {excerpt}',
          },
        },
      },
    };
  }
  if (has('pdf')) {
    out.documents = {
      [lc]: {
        document: pascalOf(t.noun),
        issued: 'Issued {date}',
        fields: Object.fromEntries(
          fields
            .filter((f) => f.type !== 'json')
            .map((f) => [f.name, words(f.name)]),
        ),
      },
    };
  }
  return out;
}

/** `dueOn` → `Due on`: a label. */
const words = (camelName) => {
  const spaced = camelName.replace(
    /[A-Z]/g,
    (letter) => ` ${letter.toLowerCase()}`,
  );
  return spaced[0].toUpperCase() + spaced.slice(1);
};
