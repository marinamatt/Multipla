# Múltipla

Plataforma interativa e temporária de campanha para o Conselho de Arquitetura. Front-end estático (HTML, Tailwind via CDN, JavaScript ES modules) + Supabase (Auth Google, PostgreSQL, RLS). Hospedagem gratuita na Netlify ou na Vercel.

## Stack

- Front-end: `index.html`, `app.js`, Tailwind CDN
- Auth: Supabase Auth (`signInWithOAuth({ provider: 'google' })`)
- Dados: PostgreSQL + Row Level Security
- Privacidade: consentimento LGPD, exclusão pelo titular, publicação pseudonimizada sem expor `user_id` no feed

## 1. Criar o projeto Supabase

1. Crie um projeto gratuito em [supabase.com](https://supabase.com).
2. Abra **SQL Editor** e execute o arquivo `script.sql`.
   Se o schema já estiver aplicado, rode também `sql/get-trending-topics.sql` para os tópicos em alta.
3. **Authentication → Providers → Google**: habilite o provedor e informe Client ID / Secret do Google Cloud.
4. **Authentication → URL Configuration**: em Redirect URLs, coloque `http://localhost:3000` e a URL de produção (Netlify/Vercel).
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
```

## 3. Rodar localmente

Os módulos ES não abrem via `file://`. Use um servidor estático:

```bash
npx --yes serve -p 3000
```

Abra `http://localhost:3000`.

## 4. Publicar (Netlify ou Vercel)

- **Netlify**: repositório Git + `netlify.toml` (publish = raiz). Sem comando de build além do placeholder.
- **Vercel**: projeto estático na raiz; `vercel.json` só define cabeçalhos.

Adicione a URL de produção nas Redirect URLs do Supabase.

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
