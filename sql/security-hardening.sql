-- Incremental: rode no SQL Editor do Supabase (pode executar de novo).
-- Fecha lacunas de autorização e spam que o cliente sozinho não garante.

-- Lista oficial de CAU: sem RLS, um GRANT acidental vaza todos os registros.
alter table public.cau_sc_ativos enable row level security;
alter table public.cau_sc_ativos force row level security;
revoke all on table public.cau_sc_ativos from public, anon, authenticated;

-- Comentários exigem o mesmo CAU + LGPD das publicações (não só o front-end).
drop policy if exists comments_insert_own on public.comments;
create policy comments_insert_own
  on public.comments
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and lgpd_consent = true
    and public.current_user_has_valid_cau()
    and public.current_user_has_lgpd_consent()
  );

create or replace function public.enforce_write_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_n integer := 0;
begin
  if v_uid is null then
    raise exception 'autenticacao obrigatoria';
  end if;
  if tg_table_name = 'posts' then
    select count(*) into v_n
    from public.posts
    where user_id = v_uid and created_at > now() - interval '30 seconds';
    if v_n >= 3 then
      raise exception 'aguarde alguns segundos antes de publicar de novo';
    end if;
  elsif tg_table_name = 'comments' then
    select count(*) into v_n
    from public.comments
    where user_id = v_uid and created_at > now() - interval '30 seconds';
    if v_n >= 8 then
      raise exception 'aguarde alguns segundos antes de comentar de novo';
    end if;
  elsif tg_table_name = 'reports' then
    select count(*) into v_n
    from public.reports
    where reporter_id = v_uid and created_at > now() - interval '30 seconds';
    if v_n >= 5 then
      raise exception 'aguarde alguns segundos antes de denunciar de novo';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists posts_rate_limit on public.posts;
create trigger posts_rate_limit
  before insert on public.posts
  for each row execute procedure public.enforce_write_rate_limit();

drop trigger if exists comments_rate_limit on public.comments;
create trigger comments_rate_limit
  before insert on public.comments
  for each row execute procedure public.enforce_write_rate_limit();

drop trigger if exists reports_rate_limit on public.reports;
create trigger reports_rate_limit
  before insert on public.reports
  for each row execute procedure public.enforce_write_rate_limit();

notify pgrst, 'reload schema';
