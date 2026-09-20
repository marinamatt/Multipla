# Múltipla

Plataforma interativa e temporária de campanha para o Conselho de Arquitetura. Front-end estático (HTML, Tailwind via CDN, JavaScript ES modules) + Supabase (Auth Google, PostgreSQL, RLS). Hospedagem na Cloudflare Pages e no GitHub Pages.

## Stack

- Front-end: `index.html`, `app.js`, Tailwind CDN
- Auth: Supabase Auth (`signInWithOAuth({ provider: 'google' })`)
- Dados: PostgreSQL + Row Level Security
- Privacidade: consentimento LGPD, exclusão pelo titular, publicação pseudonimizada sem expor `user_id` no feed

## 1. Criar o projeto Supabase

1. Crie um projeto gratuito em [supabase.com](https://supabase.com).
2. Abra **SQL Editor** e execute o arquivo `script.sql`.
   Se o schema já estiver aplicado, rode também `sql/get-trending-topics.sql` (tópicos em alta), `sql/cau-number.sql` (funções do CAU), `sql/cau-sc-ativos.sql` (lista oficial de registros ativos do CAU/SC), `sql/fix-posts-insert-cau.sql` (publicação), `sql/lgpd-consent-profile.sql` (aceite da LGPD no perfil) e `sql/security-hardening.sql` (RLS da lista CAU, CAU nos comentários e rate limit no banco).
3. **Authentication → Providers → Google**: habilite o provedor e informe Client ID / Secret do Google Cloud.
4. **Authentication → URL Configuration** — use sempre HTTPS (`http://` quebra o Google OAuth):
   - **Site URL:** `https://multipla-brx.pages.dev`
   - **Redirect URLs** (uma por linha):
     - `https://multipla-brx.pages.dev`
     - `https://multipla-brx.pages.dev/**`
     - `https://marinamatt.github.io/Multipla`
     - `https://marinamatt.github.io/Multipla/**`
     - `http://localhost:3000`
     - `http://localhost:3000/**`

   No Google Cloud (OAuth client):
   - **Authorized JavaScript origins:** `https://multipla-brx.pages.dev`, `https://marinamatt.github.io` e `http://localhost:3000`
   - **Authorized redirect URIs:** `https://vjvvticwevkicmjfxyqa.supabase.co/auth/v1/callback`

   O callback continua sendo o do Supabase; o domínio público entra em *origins* e nas Redirect URLs acima.
5. Torne um usuário administrador (depois do primeiro login):

```sql
update public.profiles
set is_admin = true
where email = 'seu-email@dominio.gov.br';
```

6. Em **Project Settings → API**, copie a **Project URL** e a chave **anon public**. Nunca use a `service_role` no front-end.

## 2. Configurar o front-end

Edite `js/config.js`:

```js
export const SUPABASE_URL = 'https://xxxx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJ...';
export const SITE_URL = 'https://multipla-brx.pages.dev';
```

## 3. Rodar localmente

Os módulos ES não abrem via `file://`. Use um servidor estático:

```bash
npx --yes serve -p 3000
```

Abra `http://localhost:3000`.

## 4. Publicar

Produção atual: [https://multipla-brx.pages.dev/](https://multipla-brx.pages.dev/) (Cloudflare Pages, branch `main`).

O GitHub Pages publica em [https://marinamatt.github.io/Multipla/](https://marinamatt.github.io/Multipla/). Não use um arquivo `CNAME` até o DNS do domínio próprio (A/CNAME para o GitHub ou para o Cloudflare) estar configurado — um `CNAME` órfão tira o site do ar.

- **Cloudflare Pages**: projeto `multipla-brx`, produção na `main`.
- **GitHub Pages**: branch de publicação configurada no repositório; arquivo `.nojekyll` na raiz.
- **Netlify / Vercel**: `netlify.toml` / `vercel.json` na raiz, se voltar a usar esses hosts.

## Privacidade e segurança

| Recurso | Onde |
| --- | --- |
| Consentimento obrigatório | Login e barra de envio / comentários |
| Publicar como anônimo | Checkbox; UI mostra “Arquiteto(a) Anônimo(a)” |
| `user_id` oculto no público | Views `posts_feed` e `comments_feed` |
| Direito de eliminação | Botão no card + “Excluir minhas contribuições” |
| Honeypot | Campo `b_phone_check` (envio abortado em silêncio) |
| Rate limit | 3 minutos no `localStorage` |
| Moderação | `profiles.is_admin`; painel de denúncias |

`is_admin` não vem de `user_metadata` (editável pelo usuário). Vive na tabela `profiles` e só pode ser alterado no SQL Editor.
