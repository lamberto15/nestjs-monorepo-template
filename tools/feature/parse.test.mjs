// The parsers' optional parts (tools/feature/{fields,capabilities,templates}.mjs):
//   node --test tools/feature/parse.test.mjs
// A part a regular expression's group did not match is `undefined`, and the
// checks below tell "absent" from "given" (`name:int` vs `name:int=30`,
// `title:string` vs `title:string(5)`); `clientAccess` is `'own'` or `false`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSettings } from './capabilities.mjs';
import { parseField, parseFields } from './fields.mjs';
import { names } from './names.mjs';
import { record } from './templates.mjs';

describe('a field type that takes no (…)', () => {
  it('accepts it bare and refuses any parentheses, empty ones too', () => {
    assert.equal(parseField('title:string').type, 'string');
    assert.throws(() => parseField('title:string(5)'), /"string" takes no/);
    assert.throws(() => parseField('done:bool()'), /"bool" takes no/);
  });

  it('still reads the (…) of an enum and a ref', () => {
    assert.deepEqual(parseField('status:enum(draft|sent)').values, [
      'draft',
      'sent',
    ]);
    assert.equal(parseField('customerId:ref(customers)?').ref, 'customers');
  });
});

describe('a setting with and without its default', () => {
  it('lets a flag go without one, and checks the one it is given', () => {
    assert.deepEqual(parseSettings('beta:flag'), [
      { name: 'beta', call: 'recordSetting.flag()' },
    ]);
    assert.deepEqual(parseSettings('beta:flag=false'), [
      { name: 'beta', call: 'recordSetting.flag()' },
    ]);
    assert.deepEqual(parseSettings('beta:flag=true'), [
      { name: 'beta', call: 'recordSetting.flag(true)' },
    ]);
    assert.throws(() => parseSettings('beta:flag=maybe'), /true or false/);
    assert.throws(() => parseSettings('beta:flag='), /true or false/);
  });

  it('needs an integer default for an int, and takes a negative one', () => {
    assert.throws(() => parseSettings('days:int'), /needs a default/);
    assert.throws(() => parseSettings('days:int=soon'), /needs a default/);
    assert.throws(() => parseSettings('days:int='), /needs a default/);
    assert.deepEqual(parseSettings('offset:int=-5'), [
      { name: 'offset', call: 'recordSetting.int(-5)' },
    ]);
  });
});

describe('the record declaration', () => {
  const declare = (extra = {}) =>
    record({
      t: names('charges'),
      fields: parseFields('title:string'),
      softDelete: false,
      unit: false,
      capabilities: new Set(),
      ...extra,
    });

  it("writes clientAccess as 'own' when asked, else false", () => {
    assert.match(
      declare({ clientAccess: 'own' }),
      /\n {2}clientAccess: 'own',/,
    );
    assert.match(declare(), /\n {2}clientAccess: false,/);
  });
});
