-- Incremental: rode no SQL Editor (pode executar de novo).
-- Threads de comentários (parent_id, máx. 2 níveis), seguir debate,
-- notificações in-app e preferências de e-mail (opt-in explícito).
-- Nunca envia e-mail daqui: só grava o aceite. O envio real exigiria um provedor
-- e ainda assim deve consultar notify_email + allow_email_notifications.

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
