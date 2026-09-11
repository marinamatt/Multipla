-- Incremental: rode no SQL Editor (pode executar de novo).
-- Validação do CAU/SC por pesquisa na relação oficial de ativos (não usa Módulo 11).
-- Depois rode também sql/cau-sc-ativos.sql para carregar a lista.

alter table public.profiles add column if not exists cau_number text;
alter table public.profiles add column if not exists lgpd_consent boolean not null default false;
alter table public.profiles add column if not exists lgpd_consent_at timestamptz;

create unique index if not exists profiles_cau_number_unique
  on public.profiles (cau_number)
  where cau_number is not null;

create table if not exists public.cau_sc_ativos (
  code text primary key
);

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

revoke all on table public.cau_sc_ativos from public, anon, authenticated;
revoke all on function public.normalize_cau_number(text) from public;
revoke all on function public.cau_number_is_valid(text) from public;
revoke all on function public.set_cau_number(text) from public;
grant execute on function public.cau_number_is_valid(text) to authenticated;
grant execute on function public.set_cau_number(text) to authenticated;

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
  lgpd_consent_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name, p.email, p.avatar_url, p.is_admin, p.cau_number, p.lgpd_consent, p.lgpd_consent_at
  from public.profiles p
  where p.id = (select auth.uid());
$$;

revoke all on function public.current_profile() from public;
grant execute on function public.current_profile() to authenticated;

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

grant update (cau_number) on public.profiles to authenticated;

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

notify pgrst, 'reload schema';
