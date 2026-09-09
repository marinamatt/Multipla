-- Incremental: rode no SQL Editor se o schema principal já foi aplicado.
-- Registro CAU em profiles + RLS de posts + RPC set_cau_number.

alter table public.profiles add column if not exists cau_number text;

create unique index if not exists profiles_cau_number_unique
  on public.profiles (cau_number)
  where cau_number is not null;

create or replace function public.normalize_cau_number(p_cau text)
returns text
language sql
immutable
as $$
  select upper(regexp_replace(btrim(coalesce(p_cau, '')), '\s+', '', 'g'));
$$;

create or replace function public.cau_digit_modulo11(p_digits text)
returns integer
language plpgsql
immutable
as $$
declare
  i int;
  soma int := 0;
  peso int := 2;
  resto int;
begin
  if p_digits is null or p_digits !~ '^[0-9]+$' then
    return null;
  end if;
  for i in reverse 1 .. char_length(p_digits) loop
    soma := soma + substr(p_digits, i, 1)::int * peso;
    peso := case when peso >= 9 then 2 else peso + 1 end;
  end loop;
  resto := soma % 11;
  if resto < 2 then
    return 0;
  end if;
  return 11 - resto;
end;
$$;

create or replace function public.cau_number_is_valid(p_cau text)
returns boolean
language plpgsql
immutable
as $$
declare
  v text := public.normalize_cau_number(p_cau);
  corpo text;
  dv int;
begin
  if v !~ '^A[0-9]{5,8}-[0-9]$' then
    return false;
  end if;
  corpo := substring(v from '^A([0-9]+)-[0-9]$');
  dv := substring(v from '-([0-9])$')::int;
  return public.cau_digit_modulo11(corpo) = dv;
end;
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
  if not public.cau_number_is_valid(v_norm) then
    raise exception 'registro CAU invalido: use o formato A123456-7 com o digito verificador correto';
  end if;

  update public.profiles
  set cau_number = v_norm
  where id = v_uid;

  if not found then
    raise exception 'perfil nao encontrado';
  end if;

  return v_norm;
exception
  when unique_violation then
    raise exception 'este registro CAU ja esta vinculado a outra conta';
end;
$$;

revoke all on function public.normalize_cau_number(text) from public;
revoke all on function public.cau_digit_modulo11(text) from public;
revoke all on function public.cau_number_is_valid(text) from public;
revoke all on function public.set_cau_number(text) from public;
grant execute on function public.set_cau_number(text) to authenticated;

-- Recria current_profile para incluir cau_number (CREATE OR REPLACE não muda o retorno).
drop function if exists public.current_profile();
create function public.current_profile()
returns table (
  id uuid,
  full_name text,
  email text,
  avatar_url text,
  is_admin boolean,
  cau_number text
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name, p.email, p.avatar_url, p.is_admin, p.cau_number
  from public.profiles p
  where p.id = (select auth.uid());
$$;

revoke all on function public.current_profile() from public;
grant execute on function public.current_profile() to authenticated;

drop policy if exists posts_insert_own on public.posts;
create policy posts_insert_own
  on public.posts
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and lgpd_consent = true
    and exists (
      select 1
      from public.profiles p
      where p.id = (select auth.uid())
        and p.cau_number is not null
        and btrim(p.cau_number) <> ''
        and public.cau_number_is_valid(p.cau_number)
    )
  );

notify pgrst, 'reload schema';
