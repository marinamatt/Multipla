-- Incremental: rode no SQL Editor (pode executar de novo).
-- Aceite da LGPD no perfil (cadastro do CAU), sem UPDATE amplo em profiles.
-- Também atualiza current_profile() para o checkbox voltar marcado.

alter table public.profiles add column if not exists lgpd_consent boolean not null default false;
alter table public.profiles add column if not exists lgpd_consent_at timestamptz;

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
    raise exception 'registro CAU invalido: numero nao consta na relacao de ativos do CAU/SC';
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

revoke all on function public.set_cau_number(text) from public;
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
