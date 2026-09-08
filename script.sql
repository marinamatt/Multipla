-- =============================================================================
-- Múltipla — Plataforma temporária de campanha / Conselho de Arquitetura
-- Script para o SQL Editor do Supabase (rode uma vez em um projeto novo)
-- =============================================================================
-- Depois de executar:
-- 1. Authentication > Providers > Google: habilite o OAuth
-- 2. Authentication > URL Configuration: adicione a URL do site (Netlify/Vercel)
-- 3. Torne um perfil admin:
--      update public.profiles set is_admin = true where email = 'seu-email@dominio.gov.br';
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Tipos
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'post_type') then
    create type public.post_type as enum ('ideia', 'reclamacao');
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Tabelas
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email text,
  avatar_url text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type public.post_type not null,
  title text,
  content text not null,
  is_anonymous boolean not null default false,
  lgpd_consent boolean not null default false,
  likes_count integer not null default 0,
  comments_count integer not null default 0,
  created_at timestamptz not null default now(),
  constraint posts_content_len check (char_length(btrim(content)) between 1 and 2000),
  constraint posts_title_len check (title is null or char_length(title) <= 120),
  constraint posts_lgpd_required check (lgpd_consent = true)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  content text not null,
  is_anonymous boolean not null default false,
  is_hidden boolean not null default false,
  lgpd_consent boolean not null default false,
  created_at timestamptz not null default now(),
  constraint comments_content_len check (char_length(btrim(content)) between 1 and 800),
  constraint comments_lgpd_required check (lgpd_consent = true)
);

create table if not exists public.likes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint likes_unique_vote unique (post_id, user_id)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  post_id uuid references public.posts (id) on delete cascade,
  comment_id uuid references public.comments (id) on delete cascade,
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  reason text not null,
  status text not null default 'aberta',
  created_at timestamptz not null default now(),
  constraint reports_reason_len check (char_length(btrim(reason)) between 3 and 500),
  constraint reports_status_ok check (status in ('aberta', 'revisada')),
  constraint reports_target check (post_id is not null or comment_id is not null)
);

create table if not exists public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  purpose text not null default 'participacao_debate',
  consented_at timestamptz not null default now(),
  constraint consents_unique unique (user_id, purpose)
);

-- Índices (FKs e ordenação do feed)
create index if not exists posts_user_id_idx on public.posts (user_id);
create index if not exists posts_created_at_idx on public.posts (created_at desc);
create index if not exists posts_likes_count_idx on public.posts (likes_count desc);
create index if not exists posts_type_idx on public.posts (type);
create index if not exists comments_post_id_idx on public.comments (post_id);
create index if not exists comments_user_id_idx on public.comments (user_id);
create index if not exists comments_created_at_idx on public.comments (created_at);
create index if not exists likes_post_id_idx on public.likes (post_id);
create index if not exists likes_user_id_idx on public.likes (user_id);
create index if not exists reports_post_id_idx on public.reports (post_id);
create index if not exists reports_comment_id_idx on public.reports (comment_id);
create index if not exists reports_status_idx on public.reports (status);

-- -----------------------------------------------------------------------------
-- Função auxiliar: admin atual (SECURITY DEFINER, só consulta o próprio JWT)
-- NÃO usa user_metadata — is_admin vive em profiles (não editável pelo usuário)
-- -----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select p.is_admin
      from public.profiles p
      where p.id = (select auth.uid())
    ),
    false
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- Perfil do usuário autenticado (inclui email e is_admin — nunca de terceiros)
create or replace function public.current_profile()
returns table (
  id uuid,
  full_name text,
  email text,
  avatar_url text,
  is_admin boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name, p.email, p.avatar_url, p.is_admin
  from public.profiles p
  where p.id = (select auth.uid());
$$;

revoke all on function public.current_profile() from public;
grant execute on function public.current_profile() to authenticated;

-- -----------------------------------------------------------------------------
-- Triggers: preencher user_id pelo JWT (auditoria) e sincronizar contadores
-- -----------------------------------------------------------------------------
create or replace function public.set_auth_user_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'autenticacao obrigatoria';
  end if;
  new.user_id := (select auth.uid());
  return new;
end;
$$;

drop trigger if exists posts_set_user on public.posts;
create trigger posts_set_user
  before insert on public.posts
  for each row execute procedure public.set_auth_user_id();

drop trigger if exists comments_set_user on public.comments;
create trigger comments_set_user
  before insert on public.comments
  for each row execute procedure public.set_auth_user_id();

drop trigger if exists likes_set_user on public.likes;
create trigger likes_set_user
  before insert on public.likes
  for each row execute procedure public.set_auth_user_id();

drop trigger if exists consents_set_user on public.consents;
create trigger consents_set_user
  before insert on public.consents
  for each row execute procedure public.set_auth_user_id();

create or replace function public.set_reporter_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'autenticacao obrigatoria';
  end if;
  new.reporter_id := (select auth.uid());
  return new;
end;
$$;

drop trigger if exists reports_set_reporter on public.reports;
create trigger reports_set_reporter
  before insert on public.reports
  for each row execute procedure public.set_reporter_id();

create or replace function public.refresh_likes_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid;
begin
  target := coalesce(new.post_id, old.post_id);
  update public.posts
  set likes_count = (select count(*) from public.likes where post_id = target)
  where id = target;
  return coalesce(new, old);
end;
$$;

drop trigger if exists likes_count_ins on public.likes;
create trigger likes_count_ins
  after insert on public.likes
  for each row execute procedure public.refresh_likes_count();

drop trigger if exists likes_count_del on public.likes;
create trigger likes_count_del
  after delete on public.likes
  for each row execute procedure public.refresh_likes_count();

create or replace function public.refresh_comments_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid;
begin
  target := coalesce(new.post_id, old.post_id);
  update public.posts
  set comments_count = (
    select count(*) from public.comments
    where post_id = target and is_hidden = false
  )
  where id = target;
  return coalesce(new, old);
end;
$$;

drop trigger if exists comments_count_ins on public.comments;
create trigger comments_count_ins
  after insert on public.comments
  for each row execute procedure public.refresh_comments_count();

drop trigger if exists comments_count_del on public.comments;
create trigger comments_count_del
  after delete on public.comments
  for each row execute procedure public.refresh_comments_count();

drop trigger if exists comments_count_upd on public.comments;
create trigger comments_count_upd
  after update of is_hidden, post_id on public.comments
  for each row execute procedure public.refresh_comments_count();

-- Perfil automático no cadastro (Google OAuth)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      'Arquiteto(a)'
    ),
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'avatar_url',
      new.raw_user_meta_data ->> 'picture'
    )
  )
  on conflict (id) do update
    set full_name = excluded.full_name,
        email = excluded.email,
        avatar_url = excluded.avatar_url;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- -----------------------------------------------------------------------------
-- Views públicas: NUNCA expõem user_id (auditoria fica só nas tabelas-base)
-- security_invoker = false (padrão): a view lê user_id internamente para
-- calcular is_own / autor, sem devolver a FK ao cliente.
-- -----------------------------------------------------------------------------
create or replace view public.posts_feed
with (security_invoker = false) as
select
  p.id,
  p.type,
  p.title,
  p.content,
  p.is_anonymous,
  p.created_at,
  p.likes_count,
  p.comments_count,
  case
    when p.is_anonymous then 'Arquiteto(a) Anônimo(a)'
    else coalesce(nullif(btrim(pr.full_name), ''), 'Arquiteto(a)')
  end as author_name,
  case
    when p.is_anonymous then null
    else pr.avatar_url
  end as author_avatar,
  (p.user_id = (select auth.uid())) as is_own,
  exists (
    select 1
    from public.likes l
    where l.post_id = p.id
      and l.user_id = (select auth.uid())
  ) as liked_by_me
from public.posts p
left join public.profiles pr on pr.id = p.user_id;

create or replace view public.comments_feed
with (security_invoker = false) as
select
  c.id,
  c.post_id,
  c.content,
  c.is_anonymous,
  c.is_hidden,
  c.created_at,
  case
    when c.is_anonymous then 'Arquiteto(a) Anônimo(a)'
    else coalesce(nullif(btrim(pr.full_name), ''), 'Arquiteto(a)')
  end as author_name,
  (c.user_id = (select auth.uid())) as is_own
from public.comments c
left join public.profiles pr on pr.id = c.user_id
where c.is_hidden = false
   or (select public.is_admin());

-- Painel de denúncias: só devolve linhas se o caller for admin
create or replace view public.reports_admin
with (security_invoker = false) as
select
  r.id,
  r.post_id,
  r.comment_id,
  r.reason,
  r.status,
  r.created_at
from public.reports r
where (select public.is_admin());

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.comments enable row level security;
alter table public.likes enable row level security;
alter table public.reports enable row level security;
alter table public.consents enable row level security;

alter table public.profiles force row level security;
alter table public.posts force row level security;
alter table public.comments force row level security;
alter table public.likes force row level security;
alter table public.reports force row level security;
alter table public.consents force row level security;

-- Privileges: mínimo necessário. user_id NÃO é selecionável nas tabelas-base.
revoke all on all tables in schema public from public, anon, authenticated;

grant select (id, full_name, avatar_url) on public.profiles to anon, authenticated;

grant insert (type, title, content, is_anonymous, lgpd_consent) on public.posts to authenticated;
grant delete on public.posts to authenticated;

grant insert (post_id, content, is_anonymous, lgpd_consent) on public.comments to authenticated;
grant delete on public.comments to authenticated;
grant update (is_hidden) on public.comments to authenticated;

grant insert (post_id) on public.likes to authenticated;
grant delete on public.likes to authenticated;

grant insert (post_id, comment_id, reason) on public.reports to authenticated;
grant update (status) on public.reports to authenticated;

grant insert (purpose) on public.consents to authenticated;
grant select (id, purpose, consented_at) on public.consents to authenticated;

grant select on public.posts_feed to anon, authenticated;
grant select on public.comments_feed to anon, authenticated;
grant select on public.reports_admin to authenticated;

-- profiles: leitura pública só dos campos concedidos (nome/foto — sem email)
drop policy if exists profiles_select_public on public.profiles;
create policy profiles_select_public
  on public.profiles
  for select
  to anon, authenticated
  using (true);

-- posts: inserção autenticada; leitura vai pela view (sem GRANT select na tabela)
drop policy if exists posts_insert_own on public.posts;
create policy posts_insert_own
  on public.posts
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and lgpd_consent = true
  );

drop policy if exists posts_delete_own_or_admin on public.posts;
create policy posts_delete_own_or_admin
  on public.posts
  for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
    or (select public.is_admin())
  );

-- comments
drop policy if exists comments_insert_own on public.comments;
create policy comments_insert_own
  on public.comments
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and lgpd_consent = true
  );

drop policy if exists comments_delete_own_or_admin on public.comments;
create policy comments_delete_own_or_admin
  on public.comments
  for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
    or (select public.is_admin())
  );

drop policy if exists comments_hide_admin on public.comments;
create policy comments_hide_admin
  on public.comments
  for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- likes: 1 voto por usuário (unique + RLS)
drop policy if exists likes_insert_own on public.likes;
create policy likes_insert_own
  on public.likes
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists likes_delete_own on public.likes;
create policy likes_delete_own
  on public.likes
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- reports
drop policy if exists reports_insert_own on public.reports;
create policy reports_insert_own
  on public.reports
  for insert
  to authenticated
  with check ((select auth.uid()) = reporter_id);

drop policy if exists reports_update_admin on public.reports;
create policy reports_update_admin
  on public.reports
  for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- consents
drop policy if exists consents_insert_own on public.consents;
create policy consents_insert_own
  on public.consents
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists consents_select_own on public.consents;
create policy consents_select_own
  on public.consents
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- RPCs (sem devolver user_id; Realtime nas tabelas-base vazaria a FK)
-- -----------------------------------------------------------------------------
create or replace function public.record_consent()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select auth.uid()) is null then
    return;
  end if;
  insert into public.consents (user_id, purpose)
  values ((select auth.uid()), 'participacao_debate')
  on conflict (user_id, purpose) do nothing;
end;
$$;

revoke all on function public.record_consent() from public;
grant execute on function public.record_consent() to authenticated;

create or replace function public.toggle_like(p_post_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  liked boolean;
  cnt integer;
begin
  if (select auth.uid()) is null then
    raise exception 'autenticacao obrigatoria';
  end if;
  if not exists (select 1 from public.posts where id = p_post_id) then
    raise exception 'publicacao inexistente';
  end if;

  if exists (
    select 1 from public.likes
    where post_id = p_post_id and user_id = (select auth.uid())
  ) then
    delete from public.likes
    where post_id = p_post_id and user_id = (select auth.uid());
    liked := false;
  else
    insert into public.likes (post_id, user_id)
    values (p_post_id, (select auth.uid()));
    liked := true;
  end if;

  select likes_count into cnt from public.posts where id = p_post_id;
  return jsonb_build_object('liked', liked, 'likes_count', coalesce(cnt, 0));
end;
$$;

revoke all on function public.toggle_like(uuid) from public;
grant execute on function public.toggle_like(uuid) to authenticated;

create or replace function public.delete_post(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'autenticacao obrigatoria';
  end if;
  if not exists (
    select 1 from public.posts
    where id = p_id
      and (user_id = (select auth.uid()) or (select public.is_admin()))
  ) then
    raise exception 'nao autorizado';
  end if;
  delete from public.posts where id = p_id;
end;
$$;

revoke all on function public.delete_post(uuid) from public;
grant execute on function public.delete_post(uuid) to authenticated;

create or replace function public.delete_comment(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'autenticacao obrigatoria';
  end if;
  if not exists (
    select 1 from public.comments
    where id = p_id
      and (user_id = (select auth.uid()) or (select public.is_admin()))
  ) then
    raise exception 'nao autorizado';
  end if;
  delete from public.comments where id = p_id;
end;
$$;

revoke all on function public.delete_comment(uuid) from public;
grant execute on function public.delete_comment(uuid) to authenticated;

create or replace function public.hide_comment(p_id uuid, p_hidden boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (select public.is_admin()) then
    raise exception 'nao autorizado';
  end if;
  update public.comments set is_hidden = p_hidden where id = p_id;
end;
$$;

revoke all on function public.hide_comment(uuid, boolean) from public;
grant execute on function public.hide_comment(uuid, boolean) to authenticated;

create or replace function public.review_report(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (select public.is_admin()) then
    raise exception 'nao autorizado';
  end if;
  update public.reports set status = 'revisada' where id = p_id;
end;
$$;

revoke all on function public.review_report(uuid) from public;
grant execute on function public.review_report(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- LGPD: o titular elimina as próprias contribuições de uma vez
-- -----------------------------------------------------------------------------
create or replace function public.delete_my_contributions()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'autenticacao obrigatoria';
  end if;
  delete from public.comments where user_id = (select auth.uid());
  delete from public.posts where user_id = (select auth.uid());
  delete from public.likes where user_id = (select auth.uid());
  delete from public.reports where reporter_id = (select auth.uid());
end;
$$;

revoke all on function public.delete_my_contributions() from public;
grant execute on function public.delete_my_contributions() to authenticated;

notify pgrst, 'reload schema';
