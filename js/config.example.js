export const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';

/** URL pública em HTTPS (ex.: https://multipla-brx.pages.dev). */
export const SITE_URL = 'https://multipla-brx.pages.dev';

export function authRedirectTo() {
  const origin = window.location.origin;
  if (origin.startsWith('http://') && !origin.includes('localhost')) {
    return origin.replace('http://', 'https://');
  }
  return origin;
}
