-- Incremental: rode no SQL Editor (pode executar de novo).
-- Corrige "permission denied for table profiles" ao publicar.
--
-- Causa: a política de INSERT em posts lia profiles.cau_number, mas o papel
-- authenticated só tem GRANT SELECT em (id, full_name, avatar_url).
-- Esta função lê o CAU como SECURITY DEFINER (sem expor o número a terceiros).

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

drop policy if exists posts_insert_own on public.posts;
create policy posts_insert_own
  on public.posts
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and lgpd_consent = true
    and public.current_user_has_valid_cau()
  );

notify pgrst, 'reload schema';
