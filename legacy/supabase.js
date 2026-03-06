// ============================================================
//  Supabase Client Configuration
//  ► Replace SUPABASE_URL and SUPABASE_ANON_KEY with your own
//    values from: Supabase Dashboard → Project Settings → API
// ============================================================

const SUPABASE_URL = 'https://uobqvsyeapezzimtorze.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvYnF2c3llYXBlenppbXRvcnplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2MTgwNDMsImV4cCI6MjA4ODE5NDA0M30.b3BTVx-76R9G6GUlPujuCO6OlkU8ps0G4OCgusQrOZY';

const { createClient } = supabase; // from CDN window.supabase
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  }
});

// Convenience export for other modules
window._sb = supabaseClient;
