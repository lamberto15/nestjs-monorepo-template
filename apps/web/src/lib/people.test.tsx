import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { PersonName, TeamName } from '@/components/person-name';
import { peopleHandler, teamsHandler } from '@/test/people';
import { server } from '@/test/server';
import { usePeopleNames } from './people';

const id = (n: number, prefix = '0199a3f2-0000-7000-8000-') =>
  `${prefix}${String(n).padStart(12, '0')}`;

const people = Array.from({ length: 45 }, (_, n) => ({
  id: id(n + 1),
  name: `Person ${n + 1}`,
}));

function wrap(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
}

describe('people and team names', () => {
  it('asks once for every key a render shows, each key once', async () => {
    const asked: URLSearchParams[] = [];
    server.use(peopleHandler(people, [], asked));
    wrap(
      <ul>
        {/* Rows 1-12, with 1-4 repeated: 12 different keys. */}
        {[...people.slice(0, 12), ...people.slice(0, 4)].map((p, n) => (
          <li key={n}>
            <PersonName value={`user:${p.id}`} />
          </li>
        ))}
      </ul>,
    );

    expect(await screen.findAllByText('Person 12')).toHaveLength(1);
    expect(screen.getAllByText('Person 1')).toHaveLength(2);
    expect(asked).toHaveLength(1);
    const keys = asked[0]?.get('key')?.split(',') ?? [];
    expect(keys).toHaveLength(12);
    expect(new Set(keys).size).toBe(12);
    expect(asked[0]?.has('q')).toBe(false);
  });

  it('splits what the route takes at once (20 keys) into as few requests', async () => {
    const asked: URLSearchParams[] = [];
    server.use(peopleHandler(people, [], asked));
    wrap(
      <>
        {people.map((p) => (
          <span key={p.id}>
            <PersonName value={`user:${p.id}`} />
          </span>
        ))}
      </>,
    );
    await waitFor(() => expect(screen.getByText(/Person 45/)).toBeVisible());
    expect(
      asked.map((q) => q.get('key')?.split(',').length).sort((a, b) => a! - b!),
    ).toEqual([5, 20, 20]);
  });

  it('keeps names: a second render asks for nothing', async () => {
    const asked: URLSearchParams[] = [];
    server.use(peopleHandler(people, [], asked));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = (
      <QueryClientProvider client={client}>
        <PersonName value={`user:${people[0]!.id}`} />
      </QueryClientProvider>
    );
    const first = render(view);
    await screen.findByText('Person 1');
    first.unmount();
    render(view);
    expect(screen.getByText('Person 1')).toBeVisible();
    expect(asked).toHaveLength(1);
  });

  it('shows the raw key while loading, and when nobody has it', async () => {
    server.use(peopleHandler(people));
    const stranger = `user:${id(999)}`;
    wrap(
      <>
        <span>
          <PersonName value={`user:${people[0]!.id}`} />
        </span>
        <span>
          <PersonName value={stranger} />
        </span>
      </>,
    );
    // Before the answer: the keys themselves.
    expect(screen.getByText(`user:${people[0]!.id}`)).toBeVisible();
    expect(await screen.findByText('Person 1')).toBeVisible();
    // The route left the stranger out: still the key, never an error.
    expect(screen.getByText(stranger)).toBeVisible();
  });

  it('never asks for what is a non-person key, and shows it as it is', async () => {
    const asked: URLSearchParams[] = [];
    server.use(peopleHandler([], [], asked));
    wrap(
      <>
        {['system:cleanup', 'anonymous', 'user:not-a-uuid'].map((key) => (
          <span key={key}>
            <PersonName value={key} />
          </span>
        ))}
      </>,
    );
    expect(screen.getByText('system:cleanup')).toBeVisible();
    expect(screen.getByText('anonymous')).toBeVisible();
    expect(screen.getByText('user:not-a-uuid')).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toHaveLength(0);
  });

  it('answers get() only for known names', async () => {
    server.use(peopleHandler(people));
    function Probe() {
      const names = usePeopleNames([`user:${people[0]!.id}`, null, undefined]);
      return (
        <p>
          {String(names.get(`user:${people[0]!.id}`))}|{String(names.pending)}
        </p>
      );
    }
    wrap(<Probe />);
    expect(screen.getByText('undefined|true')).toBeVisible();
    expect(await screen.findByText('Person 1|false')).toBeVisible();
  });

  it('names teams by id in one request', async () => {
    const asked: URLSearchParams[] = [];
    const teams = [
      { id: id(501), name: 'North' },
      { id: id(502), name: 'South' },
    ];
    server.use(teamsHandler(teams, asked));
    wrap(
      <>
        {[...teams, teams[0]!].map((t, n) => (
          <span key={n}>
            <TeamName value={t.id} />
          </span>
        ))}
      </>,
    );
    expect(await screen.findByText('South')).toBeVisible();
    expect(screen.getAllByText('North')).toHaveLength(2);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.get('id')?.split(',')).toEqual(teams.map((t) => t.id));
  });
});
