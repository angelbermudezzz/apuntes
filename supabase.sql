-- Sincronización de "Apuntes de Erika" con Supabase (gratis).
-- Pega todo esto en Supabase → SQL Editor → New query → Run.
-- Nadie puede leer la tabla directamente: solo se accede con estas funciones y el código secreto
-- de sincronización (32 letras al azar que guarda la app y va dentro del enlace).

create table if not exists public.sync_items (
  vault   text    not null,
  kind    text    not null,             -- subject | note | file | meta
  id      text    not null,
  data    jsonb,
  file    text,                         -- solo kind = file: el archivo en base64 (data URL)
  updated bigint  not null,             -- cuándo se cambió en el móvil (ms)
  deleted boolean not null default false,
  srv     bigint  not null,             -- cuándo llegó al servidor (ms), para saber qué es nuevo
  primary key (vault, kind, id)
);
create index if not exists sync_items_srv on public.sync_items (vault, srv);

alter table public.sync_items enable row level security;
revoke all on public.sync_items from anon, authenticated;

-- Cambios desde la última vez (sin el contenido de los archivos, que se pide aparte).
create or replace function public.sync_pull(p_vault text, p_since bigint)
returns table (kind text, id text, data jsonb, has_file boolean, updated bigint, deleted boolean, srv bigint)
language sql security definer set search_path = public as $$
  select s.kind, s.id, s.data, s.file is not null, s.updated, s.deleted, s.srv
  from sync_items s
  where s.vault = p_vault and length(p_vault) >= 24 and s.srv > p_since
  order by s.srv
  limit 500
$$;

create or replace function public.sync_file(p_vault text, p_id text)
returns text
language sql security definer set search_path = public as $$
  select s.file from sync_items s
  where s.vault = p_vault and length(p_vault) >= 24 and s.kind = 'file' and s.id = p_id and not s.deleted
$$;

-- Guarda una lista de cambios. Si el servidor ya tiene una versión más nueva, se queda la del servidor.
create or replace function public.sync_push(p_vault text, p_items jsonb)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if length(p_vault) < 24 then raise exception 'codigo de sincronizacion no valido'; end if;
  insert into sync_items as s (vault, kind, id, data, file, updated, deleted, srv)
  select p_vault, x->>'kind', x->>'id', x->'data', x->>'file',
         (x->>'updated')::bigint, coalesce((x->>'deleted')::boolean, false), now_ms
  from jsonb_array_elements(p_items) x
  on conflict (vault, kind, id) do update
    set data = excluded.data,
        file = case when excluded.deleted then null else coalesce(excluded.file, s.file) end,
        updated = excluded.updated, deleted = excluded.deleted, srv = excluded.srv
    where excluded.updated >= s.updated;
  return now_ms;
end
$$;

revoke all on function public.sync_pull(text, bigint), public.sync_file(text, text), public.sync_push(text, jsonb) from public;
grant execute on function public.sync_pull(text, bigint), public.sync_file(text, text), public.sync_push(text, jsonb) to anon;
