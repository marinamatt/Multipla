/**
 * Preencha com a URL e a chave anon (publicável) do projeto Supabase.
 * Nunca coloque a service_role aqui — ela ignora o RLS.
 *
 * Dashboard: Project Settings > API
 */
export const SUPABASE_URL = 'https://vjvvticwevkicmjfxyqa.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZqdnZ0aWN3ZXZraWNtamZ4eXFhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5MDI4MjQsImV4cCI6MjEwNDQ3ODgyNH0.b8-8YibNsZMcBkQ7XMFEjX_vSQwbQfpnVRuKOiikZEY';

/** URL pública da campanha (Netlify). Sempre HTTPS — Google/Supabase rejeitam http://. */
export const SITE_URL = 'https://fantastic-dodol-08e97f.netlify.app';

/** Origin usado no OAuth. Força https em *.netlify.app se a barra estiver em http. */
export function authRedirectTo() {
  const origin = window.location.origin;
  if (origin.includes('.netlify.app') && origin.startsWith('http://')) {
    return origin.replace('http://', 'https://');
  }
  return origin;
}
