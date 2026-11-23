/* Supabase browser client. Paste ONLY the project URL and the publishable (anon) key here.
   Never put the service_role key in any frontend file. Security is enforced by RLS in the database. */
const SUPABASE_URL = 'https://fjptvzxftppolutsbubf.supabase.co';
SUPABASE_PUBLISHABLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqcHR2enhmdHBwb2x1dHNidWJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzNjE1NTksImV4cCI6MjExMDkzNzU1OX0.XUYmCRBvMGsjKb8W88LmWOW0sf2PFh9DSz2JndIHWKc'

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
