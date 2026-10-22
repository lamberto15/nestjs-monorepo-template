import { describe, expect, it } from 'vitest';
import { labelFor, toBody, toDraft } from './comment-draft';

const MAYA = 'user:0199a3f2-0000-7000-8000-000000000002';
const OTTO = 'user:0199a3f2-0000-7000-8000-000000000004';
const ALEX_1 = 'user:0199a3f2-0000-7000-8000-0000000000a1';
const ALEX_2 = 'user:0199a3f2-0000-7000-8000-0000000000a2';

describe('toBody', () => {
  it('writes the id of each person picked, and nothing else', () => {
    expect(
      toBody('Ask @Maya Patel, then @Otto Lang. a@b.co @Nobody', {
        [MAYA]: 'Maya Patel',
        [OTTO]: 'Otto Lang',
      }),
    ).toBe(`Ask @${MAYA}, then @${OTTO}. a@b.co @Nobody`);
  });

  it('is the text itself when nobody is picked', () => {
    expect(toBody('Hi @Maya Patel', {})).toBe('Hi @Maya Patel');
  });

  it('takes the longest label first, and only whole words', () => {
    const picked = { [MAYA]: 'Maya', [OTTO]: 'Maya Patel' };
    expect(toBody('@Maya Patel and @Maya, not @Mayanna', picked)).toBe(
      `@${OTTO} and @${MAYA}, not @Mayanna`,
    );
  });

  it('leaves a label cut short or inside a word as typed', () => {
    const picked = { [MAYA]: 'Maya Patel' };
    expect(toBody('@Maya Pate x@Maya Patel @Maya Patelson', picked)).toBe(
      '@Maya Pate x@Maya Patel @Maya Patelson',
    );
  });

  it('converts where the API reads a mention: after a bracket, a quote, a comma', () => {
    const picked = { [MAYA]: 'Maya Patel' };
    expect(toBody('see (@Maya Patel) "@Maya Patel" ,@Maya Patel', picked)).toBe(
      `see (@${MAYA}) "@${MAYA}" ,@${MAYA}`,
    );
    // Where it reads none: inside a word, an address or after a full stop.
    expect(toBody('x@Maya Patel a.@Maya Patel @@Maya Patel', picked)).toBe(
      'x@Maya Patel a.@Maya Patel @@Maya Patel',
    );
  });

  it('leaves a label that starts a longer address or hyphenated word', () => {
    const picked = { [MAYA]: 'sam' };
    expect(
      toBody('cc @sam.jones@corp.com, @sam@corp.com, @sam-lee', picked),
    ).toBe('cc @sam.jones@corp.com, @sam@corp.com, @sam-lee');
    expect(toBody('hi @sam. and @sam+', picked)).toBe(
      `hi @${MAYA}. and @${MAYA}+`,
    );
  });

  it('reads a name with characters a pattern would', () => {
    const picked = { [MAYA]: 'Dr. (Maya) Patel+Co' };
    expect(toBody('hi @Dr. (Maya) Patel+Co!', picked)).toBe(`hi @${MAYA}!`);
    expect(toBody('hi @Dr. XMaya) Patel+Co!', picked)).toBe(
      'hi @Dr. XMaya) Patel+Co!',
    );
  });

  it('keeps every line and space of the text', () => {
    expect(toBody('a\n@Maya Patel\n\n  b', { [MAYA]: 'Maya Patel' })).toBe(
      `a\n@${MAYA}\n\n  b`,
    );
  });
});

describe('labelFor', () => {
  it('is the name, unless another person has it', () => {
    const used = new Map([
      [MAYA, 'Maya Patel'],
      [OTTO, 'Otto Lang'],
    ]);
    expect(labelFor(MAYA, 'Maya Patel', used)).toBe('Maya Patel');
    expect(labelFor(ALEX_1, 'Maya Patel', used)).toBe(
      `Maya Patel (${ALEX_1.slice(-4)})`,
    );
  });

  it("lengthens the end of the id while the label is another person's", () => {
    const used = new Map([
      [ALEX_1, 'Alex Kim'],
      [ALEX_2, 'Alex Kim (00a2)'],
      ['user:ffffffff-0000-7000-8000-0000000000a2', 'Alex Kim'],
    ]);
    expect(
      labelFor('user:eeeeeeee-0000-7000-8000-0000000000a2', 'Alex Kim', used),
    ).toBe('Alex Kim (000a2)');
  });

  it('puts a name on one line, as the input does', () => {
    expect(labelFor(MAYA, 'Dana\nKim', new Map())).toBe('Dana Kim');
    expect(labelFor(MAYA, 'Dana  Kim', new Map())).toBe('Dana Kim');
    // Two names that differ only in their breaks are one name.
    const used = new Map([[OTTO, 'Dana Kim']]);
    expect(labelFor(MAYA, 'Dana\nKim', used)).toBe(
      `Dana Kim (${MAYA.slice(-4)})`,
    );
  });

  it('tells two people of one name apart, and keeps the toBody mapping exact', () => {
    const used = new Map([
      [ALEX_1, 'Alex Kim'],
      [ALEX_2, 'Alex Kim'],
    ]);
    const one = labelFor(ALEX_1, 'Alex Kim', used);
    const two = labelFor(ALEX_2, 'Alex Kim', used);
    expect(one).not.toBe(two);
    expect(
      toBody(`@${one} and @${two}`, { [ALEX_1]: one, [ALEX_2]: two }),
    ).toBe(`@${ALEX_1} and @${ALEX_2}`);
  });
});

describe('toDraft', () => {
  it('names the people the body mentions, and only those it can name', () => {
    const stranger = 'user:0199a3f2-0000-7000-8000-000000000003';
    const { text, picked } = toDraft(
      `Hi @${MAYA} and @${stranger} and @${OTTO.toUpperCase()}, @a@b.co`,
      { [MAYA]: 'Maya Patel', [stranger]: null, [OTTO]: 'Otto Lang' },
    );
    expect(text).toBe(
      `Hi @Maya Patel and @${stranger} and @Otto Lang, @a@b.co`,
    );
    expect(picked).toEqual({ [MAYA]: 'Maya Patel', [OTTO]: 'Otto Lang' });
  });

  it('is the body itself without names', () => {
    expect(toDraft(`Hi @${MAYA}`)).toEqual({ text: `Hi @${MAYA}`, picked: {} });
  });

  it('leaves a mention in place where its name would not survive, and so keeps it', () => {
    const names = { [MAYA]: 'Maya Patel' };
    for (const body of [
      `cc (@${MAYA}) now`,
      `"@${MAYA}"`,
      `x,@${MAYA}`,
      `[@${MAYA}]`,
      `a-@${MAYA}`,
      `hi @${MAYA}.`,
      // Not converted: the name would run into the next word, or the text
      // is no mention for the API ("a.@id" follows a full stop).
      `@${MAYA}x`,
      `a.@${MAYA}`,
      `@${MAYA}.com`,
    ]) {
      const { text, picked } = toDraft(body, names);
      expect(toBody(text, picked)).toBe(body);
    }
    expect(toDraft(`@${MAYA}x`, names).text).toBe(`@${MAYA}x`);
    expect(toDraft(`(@${MAYA})`, names).text).toBe('(@Maya Patel)');
  });

  it('round-trips through toBody, ids in lower case', () => {
    const body = `x @${MAYA}\n@${ALEX_1} @${ALEX_2} @${MAYA}`;
    const { text, picked } = toDraft(body, {
      [MAYA]: 'Maya Patel',
      [ALEX_1]: 'Alex Kim',
      [ALEX_2]: 'Alex Kim',
    });
    expect(text).not.toContain('user:');
    expect(toBody(text, picked)).toBe(body);
  });
});
