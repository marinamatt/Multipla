-- Incremental: rode no SQL Editor se o schema principal já foi aplicado.
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

notify pgrst, 'reload schema';
