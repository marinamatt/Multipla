export const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';

/** URL pública em HTTPS (ex.: https://fantastic-dodol-08e97f.netlify.app). */
export const SITE_URL = 'https://fantastic-dodol-08e97f.netlify.app';

export function authRedirectTo() {
  const origin = window.location.origin;
  if (origin.includes('.netlify.app') && origin.startsWith('http://')) {
    return origin.replace('http://', 'https://');
  }
  return origin;
}
