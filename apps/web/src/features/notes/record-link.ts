import { unwrap } from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';
import type { RecordLink } from '@/features/watching/record-links';

/** Where a watched note opens, and its title (features/watching). */
export default {
  subject: 'Note',
  path: (id) => `/notes/${id}`,
  title: async (id) =>
    (await unwrap(api.GET('/v1/notes/{id}', { params: { path: { id } } })))
      .title,
} satisfies RecordLink;
