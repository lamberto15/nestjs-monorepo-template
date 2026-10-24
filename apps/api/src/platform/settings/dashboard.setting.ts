import { z } from 'zod';
import { defineSettings, setting } from './setting.types.js';

export const DASHBOARD_LAYOUT = setting({
  key: 'dashboard.layout',
  label: 'Dashboard layout',
  description: 'Which dashboard cards you hide and the order you prefer.',
  schema: z
    .object({
      hidden: z.array(z.string().min(1).max(100)).max(100),
      order: z.array(z.string().min(1).max(100)).max(100),
    })
    .strict(),
  default: { hidden: [], order: [] },
  scopes: ['user'],
});

export const DASHBOARD_SETTINGS = defineSettings([DASHBOARD_LAYOUT]);
