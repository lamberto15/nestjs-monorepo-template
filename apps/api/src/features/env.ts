import { z } from 'zod';
import { notesEnv } from './notes/notes.env.js';

/**
 * Every feature's variables (`<x>.env.ts`), for env.ts. A feature with
 * variables adds its shape here (and to env.example).
 */
export const featuresEnv = z.object({
  ...notesEnv.shape,
});
