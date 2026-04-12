import { requireEnv } from '@utils/env';
import { defineConfig } from 'drizzle-kit';

export const DATABASE_URL = requireEnv('DATABASE_URL');

export default defineConfig({
  out: './drizzle',
  schema: './schemas',
  dialect: 'postgresql',
  dbCredentials: {
    url: DATABASE_URL,
  },
});
