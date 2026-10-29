import {
  type ChoiceProvider,
  ChoicesRegistry,
  paramFits,
} from './choices.registry.js';

const provider = (
  key: string,
  params: ChoiceProvider['params'] = {},
): ChoiceProvider => ({
  key,
  label: key,
  params,
  mayUse: async () => true,
  options: async () => [],
  has: async () => true,
});

describe('ChoicesRegistry', () => {
  let registry: ChoicesRegistry;
  beforeEach(() => {
    registry = new ChoicesRegistry();
    registry.provider(provider('customers'));
    registry.provider(provider('projects', { customerId: 'uuid' }));
    registry.provider(provider('tasks', { projectId: 'uuid' }));
  });

  it('accepts a chain of dependent fields', () => {
    registry.set({
      key: 'work',
      label: 'Work',
      fields: {
        customer: { provider: 'customers' },
        project: { provider: 'projects', params: { customerId: 'customer' } },
        task: { provider: 'tasks', params: { projectId: 'project' } },
      },
    });
    expect(registry.getSet('work')?.key).toBe('work');
  });

  it('rejects a cycle between fields', () => {
    registry.provider(provider('a', { x: 'string' }));
    expect(() =>
      registry.set({
        key: 'loop',
        label: 'Loop',
        fields: {
          one: { provider: 'a', params: { x: 'two' } },
          two: { provider: 'a', params: { x: 'one' } },
        },
      }),
    ).toThrow(/a cycle: one → two → one/);
    expect(registry.getSet('loop')).toBeUndefined();
  });

  it('rejects a field that depends on itself', () => {
    expect(() =>
      registry.set({
        key: 'self',
        label: 'Self',
        fields: {
          project: { provider: 'projects', params: { customerId: 'project' } },
        },
      }),
    ).toThrow(/depends on itself/);
  });

  it('rejects an unregistered provider, an unfilled or unknown parameter, and a parent outside the set', () => {
    const set = (fields: Record<string, never> | object) =>
      registry.set({ key: 'bad', label: 'Bad', fields: fields as never });
    expect(() => set({ a: { provider: 'nope' } })).toThrow(/unregistered/);
    expect(() => set({ a: { provider: 'projects' } })).toThrow(
      /must fill exactly the parameters/,
    );
    expect(() =>
      set({ a: { provider: 'customers', params: { extra: 'a' } } }),
    ).toThrow(/must fill exactly the parameters/);
    expect(() =>
      set({ a: { provider: 'projects', params: { customerId: 'ghost' } } }),
    ).toThrow(/not a field of the set/);
  });

  it('rejects a chain deeper than the limit', () => {
    registry.provider(provider('step', { prev: 'string' }));
    expect(() =>
      registry.set({
        key: 'deep',
        label: 'Deep',
        fields: {
          f0: { provider: 'customers' },
          f1: { provider: 'step', params: { prev: 'f0' } },
          f2: { provider: 'step', params: { prev: 'f1' } },
          f3: { provider: 'step', params: { prev: 'f2' } },
          f4: { provider: 'step', params: { prev: 'f3' } },
        },
      }),
    ).toThrow(/levels deep/);
  });

  it('types a parameter before a provider sees it', () => {
    expect(paramFits('uuid', 'not-a-uuid')).toBe(false);
    expect(paramFits('uuid', '6f1c3a52-7c52-4d0e-9d6b-3c2f9a4e8b10')).toBe(
      true,
    );
    expect(paramFits('string', '')).toBe(false);
    expect(paramFits('string', 'x'.repeat(201))).toBe(false);
  });
});
