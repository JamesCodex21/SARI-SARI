/* Supabase browser client. Paste ONLY the project URL and the publishable (anon) key here.
   Never put the service_role key in any frontend file. Security is enforced by RLS in the database. */
const SUPABASE_URL = 'https://fjptvzxftppolutsbubf.supabase.co';
SUPABASE_PUBLISHABLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
