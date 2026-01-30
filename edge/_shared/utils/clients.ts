import type { Database } from '../types/database.ts'

import { createClient } from '@supabase/supabase-js'
import { getSupabaseConfig } from './config.ts'
import { getEnv, requireEnv } from './env.ts'

export function createAdminClient() {
  const config = getSupabaseConfig({
    publicKey: getEnv('SUPABASE_PUBLIC_KEY') || requireEnv('SUPABASE_ANON_KEY'),
    secretKey: getEnv('SUPABASE_SECRET_KEY') || requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  });

  return createClient<Database>(
    config.url,
    config.secretKey!,
  )
}

export function createUserClient(authHeader: string) {
  const config = getSupabaseConfig({
    publicKey: getEnv('SUPABASE_PUBLIC_KEY') || requireEnv('SUPABASE_ANON_KEY'),
    secretKey: getEnv('SUPABASE_SECRET_KEY') || requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  });

  return createClient<Database>(
    config.url,
    config.publicKey!,
    {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    },
  )
}
