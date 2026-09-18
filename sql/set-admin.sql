-- Marcar administrador da Múltipla (SQL Editor do Supabase).
-- O cargo vive em profiles.is_admin. Não adianta colocar no Google nem em user_metadata.
-- Use o MESMO e-mail da conta Google com que você entra no site. Depois, saia e entre de novo.

-- 1) Veja os perfis (confira o e-mail exato):
select id, email, full_name, is_admin, created_at
from public.profiles
order by created_at;

-- 2) Marque o seu (troque o e-mail):
update public.profiles
set is_admin = true
where email = 'seu-email@gmail.com';

-- Se o e-mail no Google tiver maiúsculas ou variação, use:
-- update public.profiles set is_admin = true where email ilike 'seu-email@gmail.com';

-- 3) Confirme:
select email, full_name, is_admin from public.profiles where is_admin = true;
