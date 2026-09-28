import 'server-only';
import { createClient } from '@supabase/supabase-js';

/**
 * Cliente Supabase do servidor, no mesmo projeto do Pedido Central.
 * Usa a service role: a tabela de cadastros guarda CPF e não tem política de RLS
 * aberta, então nada disso pode rodar no navegador.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder';

export const supabaseServer = createClient(url, chave, {
  auth: { autoRefreshToken: false, persistSession: false },
});
