-- =============================================================================
-- Múltipla — Plataforma temporária de campanha / Conselho de Arquitetura
-- Script para o SQL Editor do Supabase (rode uma vez em um projeto novo)
-- =============================================================================
-- Depois de executar:
-- 1. Authentication > Providers > Google: habilite o OAuth
-- 2. Authentication > URL Configuration (sempre HTTPS no Netlify):
--    Site URL: https://fantastic-dodol-08e97f.netlify.app
--    Redirect URLs:
--      https://fantastic-dodol-08e97f.netlify.app
--      https://fantastic-dodol-08e97f.netlify.app/**
--      http://localhost:3000
--      http://localhost:3000/**
-- 3. Torne um perfil admin:
--      update public.profiles set is_admin = true where email = 'seu-email@dominio.gov.br';
-- 4. Rode sql/cau-sc-ativos.sql para carregar a lista oficial de registros CAU/SC.
-- 5. Se publicar der "permission denied for table profiles", rode sql/fix-posts-insert-cau.sql.
-- 6. Para gravar o aceite da LGPD no perfil, rode sql/lgpd-consent-profile.sql.
-- 7. Para threads, seguir debate e notificações, rode sql/threads-notifications.sql.
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
  cau_number text,
  lgpd_consent boolean not null default false,
  lgpd_consent_at timestamptz,
  allow_email_notifications boolean not null default true,
  notify_in_app boolean not null default true,
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
  parent_id uuid references public.comments (id) on delete cascade,
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

-- cau_number: registro CAU validado (A + números + DV módulo 11). Sem UPDATE direto.
alter table public.profiles add column if not exists cau_number text;
alter table public.profiles add column if not exists lgpd_consent boolean not null default false;
alter table public.profiles add column if not exists lgpd_consent_at timestamptz;
create unique index if not exists profiles_cau_number_unique
  on public.profiles (cau_number)
  where cau_number is not null;

create table if not exists public.cau_sc_ativos (
  code text primary key
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

-- Perfil do usuário autenticado (inclui email, is_admin e cau_number — nunca de terceiros)
drop function if exists public.current_profile();
create function public.current_profile()
returns table (
  id uuid,
  full_name text,
  email text,
  avatar_url text,
  is_admin boolean,
  cau_number text,
  lgpd_consent boolean,
  lgpd_consent_at timestamptz,
  allow_email_notifications boolean,
  notify_in_app boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id, p.full_name, p.email, p.avatar_url, p.is_admin, p.cau_number,
    p.lgpd_consent, p.lgpd_consent_at, p.allow_email_notifications, p.notify_in_app
  from public.profiles p
  where p.id = (select auth.uid());
$$;

revoke all on function public.current_profile() from public;
grant execute on function public.current_profile() to authenticated;

-- -----------------------------------------------------------------------------
-- Registro CAU/SC: pesquisa na relação oficial de ativos (sql/cau-sc-ativos.sql)
-- Sem GRANT UPDATE amplo em profiles — o cliente grava via set_cau_number().
-- -----------------------------------------------------------------------------
create or replace function public.normalize_cau_number(p_cau text)
returns text
language plpgsql
immutable
as $$
declare
  v text;
begin
  v := upper(regexp_replace(btrim(coalesce(p_cau, '')), '[.\s\-]+', '', 'g'));
  v := regexp_replace(v, '^0+', '');
  if v is null or v = '' then
    return null;
  end if;
  if v ~ '^[0-9]+$' then
    v := 'A' || v;
  end if;
  if v !~ '^A[0-9]+$' then
    return null;
  end if;
  return lpad(v, 10, '0');
end;
$$;

drop function if exists public.cau_digit_modulo11(text);
drop function if exists public.cau_digit_modulo11_ltr(text);

create or replace function public.cau_number_is_valid(p_cau text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.cau_sc_ativos a
    where a.code = public.normalize_cau_number(p_cau)
  );
$$;

alter table public.profiles drop constraint if exists profiles_cau_number_valid;
alter table public.profiles
  add constraint profiles_cau_number_valid
  check (cau_number is null or public.cau_number_is_valid(cau_number));

create or replace function public.set_cau_number(p_cau text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_norm text;
begin
  if v_uid is null then
    raise exception 'autenticacao obrigatoria';
  end if;

  v_norm := public.normalize_cau_number(p_cau);
  if v_norm is null or not public.cau_number_is_valid(v_norm) then
    raise exception 'registro CAU inválido';
  end if;

  insert into public.profiles (id, cau_number, lgpd_consent, lgpd_consent_at)
  values (v_uid, v_norm, true, now())
  on conflict (id) do update
    set cau_number = excluded.cau_number,
        lgpd_consent = true,
        lgpd_consent_at = coalesce(public.profiles.lgpd_consent_at, now());

  if not exists (
    select 1 from public.profiles where id = v_uid and cau_number = v_norm
  ) then
    raise exception 'nao foi possivel salvar o registro CAU';
  end if;

  return v_norm;
exception
  when unique_violation then
    raise exception 'este registro CAU ja esta vinculado a outra conta';
end;
$$;

revoke all on function public.normalize_cau_number(text) from public;
revoke all on function public.cau_number_is_valid(text) from public;
revoke all on function public.set_cau_number(text) from public;
grant execute on function public.cau_number_is_valid(text) to authenticated;
grant execute on function public.set_cau_number(text) to authenticated;

create or replace function public.current_user_has_valid_cau()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.cau_number is not null
      and btrim(p.cau_number) <> ''
      and public.cau_number_is_valid(p.cau_number)
  );
$$;

revoke all on function public.current_user_has_valid_cau() from public;
grant execute on function public.current_user_has_valid_cau() to authenticated;

create or replace function public.current_user_has_lgpd_consent()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select p.lgpd_consent
      from public.profiles p
      where p.id = (select auth.uid())
    ),
    false
  );
$$;

revoke all on function public.current_user_has_lgpd_consent() from public;
grant execute on function public.current_user_has_lgpd_consent() to authenticated;

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
  c.parent_id,
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
grant update (cau_number) on public.profiles to authenticated;

grant insert (type, title, content, is_anonymous, lgpd_consent) on public.posts to authenticated;
grant delete on public.posts to authenticated;

grant insert (post_id, content, is_anonymous, lgpd_consent, parent_id) on public.comments to authenticated;
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

-- Só o próprio cau_number (GRANT não inclui is_admin). Precisa existir porque profiles usa FORCE RLS.
drop policy if exists profiles_update_own_cau on public.profiles;
create policy profiles_update_own_cau
  on public.profiles
  for update
  to authenticated
  using (id = (select auth.uid()))
  with check (
    id = (select auth.uid())
    and public.cau_number_is_valid(cau_number)
  );

-- posts: inserção autenticada só com LGPD e registro CAU preenchido no perfil
drop policy if exists posts_insert_own on public.posts;
create policy posts_insert_own
  on public.posts
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and lgpd_consent = true
    and public.current_user_has_valid_cau()
    and public.current_user_has_lgpd_consent()
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

  update public.profiles
  set
    lgpd_consent = true,
    lgpd_consent_at = coalesce(lgpd_consent_at, now())
  where id = (select auth.uid());
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

-- -----------------------------------------------------------------------------
-- Tópicos em alta (hashtags em posts e comentários visíveis)
-- SECURITY DEFINER: o cliente não tem SELECT nas tabelas-base (user_id oculto)
-- -----------------------------------------------------------------------------
create or replace function public.get_trending_topics()
returns table (topic text, total bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    lower(match[1]) as topic,
    count(*)::bigint as total
  from (
    select content from public.posts
    union all
    select content from public.comments where is_hidden = false
  ) combined_content
  cross join lateral regexp_matches(
    combined_content.content,
    '#([A-Za-z0-9_À-ÿ]+)',
    'g'
  ) as match
  group by 1
  order by total desc, topic asc
  limit 5;
$$;

revoke all on function public.get_trending_topics() from public;
grant execute on function public.get_trending_topics() to anon, authenticated;

-- Threads, seguir debate e notificações (idempotente; ver sql/threads-notifications.sql)
alter table public.comments
  add column if not exists parent_id uuid references public.comments (id) on delete cascade;

create index if not exists comments_parent_id_idx on public.comments (parent_id);
create index if not exists comments_post_parent_idx on public.comments (post_id, parent_id);

alter table public.profiles
  add column if not exists allow_email_notifications boolean not null default true;
alter table public.profiles
  add column if not exists notify_in_app boolean not null default true;

create table if not exists public.post_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  post_id uuid not null references public.posts (id) on delete cascade,
  notify_email boolean not null default false,
  created_at timestamptz not null default now(),
  constraint post_subscriptions_unique unique (user_id, post_id)
);

create index if not exists post_subscriptions_user_idx on public.post_subscriptions (user_id);
create index if not exists post_subscriptions_post_idx on public.post_subscriptions (post_id);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null,
  post_id uuid references public.posts (id) on delete cascade,
  comment_id uuid references public.comments (id) on delete cascade,
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_type_ok check (type in ('comment_reply', 'followed_comment', 'post_comment')),
  constraint notifications_message_len check (char_length(btrim(message)) between 1 and 400)
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_user_unread_idx
  on public.notifications (user_id)
  where read_at is null;

alter table public.post_subscriptions enable row level security;
alter table public.notifications enable row level security;
alter table public.post_subscriptions force row level security;
alter table public.notifications force row level security;

revoke all on public.post_subscriptions from public, anon, authenticated;
revoke all on public.notifications from public, anon, authenticated;

-- Cliente não lê as tabelas-base (evita user_id alheio). Acesso só via RPC/view.

create or replace function public.comments_validate_parent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent public.comments;
begin
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'comentario pai invalido';
  end if;
  select * into v_parent from public.comments where id = new.parent_id;
  if not found then
    raise exception 'comentario pai nao encontrado';
  end if;
  if v_parent.post_id <> new.post_id then
    raise exception 'resposta deve ser do mesmo debate';
  end if;
  if v_parent.parent_id is not null then
    raise exception 'respostas aninhadas no maximo em 2 niveis';
  end if;
  return new;
end;
$$;

drop trigger if exists comments_validate_parent on public.comments;
create trigger comments_validate_parent
  before insert or update of parent_id, post_id on public.comments
  for each row execute procedure public.comments_validate_parent();

create or replace function public.actor_display_name(p_user_id uuid, p_anonymous boolean)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_anonymous then 'Arquiteto(a) Anônimo(a)'
    else coalesce(nullif(btrim(pr.full_name), ''), 'Arquiteto(a)')
  end
  from public.profiles pr
  where pr.id = p_user_id;
$$;

create or replace function public.post_title_snippet(p_post_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select left(
    coalesce(nullif(btrim(p.title), ''), nullif(btrim(p.content), ''), 'proposta'),
    80
  )
  from public.posts p
  where p.id = p_post_id;
$$;

create or replace function public.user_wants_in_app(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select pr.notify_in_app from public.profiles pr where pr.id = p_user_id),
    true
  );
$$;

create or replace function public.notify_comment_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text;
  v_title text;
  v_parent_uid uuid;
  v_post_uid uuid;
  v_sub record;
  v_notified uuid[] := array[]::uuid[];
begin
  if new.is_hidden then
    return new;
  end if;

  v_actor := coalesce(public.actor_display_name(new.user_id, new.is_anonymous), 'Arquiteto(a)');
  v_title := coalesce(public.post_title_snippet(new.post_id), 'proposta');

  if new.parent_id is not null then
    select c.user_id into v_parent_uid from public.comments c where c.id = new.parent_id;
    if v_parent_uid is not null
       and v_parent_uid <> new.user_id
       and public.user_wants_in_app(v_parent_uid) then
      insert into public.notifications (user_id, type, post_id, comment_id, message)
      values (
        v_parent_uid,
        'comment_reply',
        new.post_id,
        new.id,
        v_actor || ' respondeu ao seu comentário na proposta ' || v_title
      );
      v_notified := array_append(v_notified, v_parent_uid);
    end if;
  end if;

  select p.user_id into v_post_uid from public.posts p where p.id = new.post_id;
  if v_post_uid is not null
     and v_post_uid <> new.user_id
     and not (v_post_uid = any (v_notified))
     and public.user_wants_in_app(v_post_uid) then
    insert into public.notifications (user_id, type, post_id, comment_id, message)
    values (
      v_post_uid,
      'post_comment',
      new.post_id,
      new.id,
      v_actor || ' comentou na sua proposta ' || v_title
    );
    v_notified := array_append(v_notified, v_post_uid);
  end if;

  for v_sub in
    select s.user_id
    from public.post_subscriptions s
    where s.post_id = new.post_id
      and s.user_id <> new.user_id
  loop
    if v_sub.user_id = any (v_notified) then
      continue;
    end if;
    if not public.user_wants_in_app(v_sub.user_id) then
      continue;
    end if;
    insert into public.notifications (user_id, type, post_id, comment_id, message)
    values (
      v_sub.user_id,
      'followed_comment',
      new.post_id,
      new.id,
      'Novo comentário no debate que você segue: ' || v_title
    );
    v_notified := array_append(v_notified, v_sub.user_id);
  end loop;

  return new;
end;
$$;

drop trigger if exists comments_notify on public.comments;
create trigger comments_notify
  after insert on public.comments
  for each row execute procedure public.notify_comment_created();

create or replace view public.comments_feed
with (security_invoker = false) as
select
  c.id,
  c.post_id,
  c.parent_id,
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

create or replace view public.notifications_mine
with (security_invoker = false) as
select
  n.id,
  n.type,
  n.post_id,
  n.comment_id,
  n.message,
  n.read_at,
  n.created_at
from public.notifications n
where n.user_id = (select auth.uid());

grant select on public.comments_feed to anon, authenticated;
grant select on public.notifications_mine to authenticated;
grant insert (post_id, content, is_anonymous, lgpd_consent, parent_id) on public.comments to authenticated;

drop function if exists public.current_profile();
create function public.current_profile()
returns table (
  id uuid,
  full_name text,
  email text,
  avatar_url text,
  is_admin boolean,
  cau_number text,
  lgpd_consent boolean,
  lgpd_consent_at timestamptz,
  allow_email_notifications boolean,
  notify_in_app boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    p.full_name,
    p.email,
    p.avatar_url,
    p.is_admin,
    p.cau_number,
    p.lgpd_consent,
    p.lgpd_consent_at,
    p.allow_email_notifications,
    p.notify_in_app
  from public.profiles p
  where p.id = (select auth.uid());
$$;

revoke all on function public.current_profile() from public;
grant execute on function public.current_profile() to authenticated;

create or replace function public.set_notification_prefs(
  p_allow_email boolean,
  p_notify_in_app boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'autenticacao obrigatoria';
  end if;
  update public.profiles
  set
    allow_email_notifications = coalesce(p_allow_email, allow_email_notifications),
    notify_in_app = coalesce(p_notify_in_app, notify_in_app)
  where id = v_uid;
end;
$$;

revoke all on function public.set_notification_prefs(boolean, boolean) from public;
grant execute on function public.set_notification_prefs(boolean, boolean) to authenticated;

create or replace function public.subscribe_to_post(p_post_id uuid, p_notify_email boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'autenticacao obrigatoria';
  end if;
  if p_post_id is null or not exists (select 1 from public.posts where id = p_post_id) then
    raise exception 'debate nao encontrado';
  end if;
  insert into public.post_subscriptions (user_id, post_id, notify_email)
  values (v_uid, p_post_id, coalesce(p_notify_email, false))
  on conflict (user_id, post_id) do update
    set notify_email = excluded.notify_email;
end;
$$;

revoke all on function public.subscribe_to_post(uuid, boolean) from public;
grant execute on function public.subscribe_to_post(uuid, boolean) to authenticated;

create or replace function public.unsubscribe_from_post(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'autenticacao obrigatoria';
  end if;
  delete from public.post_subscriptions
  where user_id = v_uid and post_id = p_post_id;
end;
$$;

revoke all on function public.unsubscribe_from_post(uuid) from public;
grant execute on function public.unsubscribe_from_post(uuid) to authenticated;

create or replace function public.set_subscription_email(p_post_id uuid, p_notify_email boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'autenticacao obrigatoria';
  end if;
  update public.post_subscriptions
  set notify_email = coalesce(p_notify_email, false)
  where user_id = v_uid and post_id = p_post_id;
end;
$$;

revoke all on function public.set_subscription_email(uuid, boolean) from public;
grant execute on function public.set_subscription_email(uuid, boolean) to authenticated;

create or replace function public.list_my_subscriptions()
returns table (
  post_id uuid,
  post_title text,
  notify_email boolean,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.post_id,
    left(coalesce(nullif(btrim(p.title), ''), nullif(btrim(p.content), ''), 'proposta'), 80) as post_title,
    s.notify_email,
    s.created_at
  from public.post_subscriptions s
  join public.posts p on p.id = s.post_id
  where s.user_id = (select auth.uid())
  order by s.created_at desc;
$$;

revoke all on function public.list_my_subscriptions() from public;
grant execute on function public.list_my_subscriptions() to authenticated;

create or replace function public.mark_notification_read(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'autenticacao obrigatoria';
  end if;
  update public.notifications
  set read_at = coalesce(read_at, now())
  where id = p_id and user_id = v_uid;
end;
$$;

revoke all on function public.mark_notification_read(uuid) from public;
grant execute on function public.mark_notification_read(uuid) to authenticated;

notify pgrst, 'reload schema';
