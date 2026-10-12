create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  role         text not null check (role in ('mestre', 'jogador')),
  created_at   timestamptz not null default now()
);

create table public.rooms (
  id            bigint generated always as identity primary key,
  name          text not null check (char_length(name) between 1 and 60),
  description   text not null default '' check (char_length(description) <= 500),
  master_id     uuid not null references public.profiles (id) on delete cascade,
  master_target jsonb not null default '{"type":"all"}'::jsonb,
  created_at    timestamptz not null default now()
);
create index rooms_master_id_idx on public.rooms (master_id);

create table public.room_invites (
  room_id bigint primary key references public.rooms (id) on delete cascade,
  code    text not null unique
);

create table public.zones (
  id       bigint generated always as identity primary key,
  room_id  bigint not null references public.rooms (id) on delete cascade,
  name     text not null check (char_length(name) between 1 and 40),
  position integer not null default 0
);
create index zones_room_id_idx on public.zones (room_id);

create table public.room_members (
  room_id           bigint not null references public.rooms (id) on delete cascade,
  user_id           uuid not null references public.profiles (id) on delete cascade,
  zone_id           bigint references public.zones (id) on delete set null,
  whisper_to_master boolean not null default false,
  joined_at         timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index room_members_user_id_idx on public.room_members (user_id);
create index room_members_zone_id_idx on public.room_members (zone_id);

create table public.signals (
  id           bigint generated always as identity primary key,
  room_id      bigint not null references public.rooms (id) on delete cascade,
  from_user    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  from_session text not null check (char_length(from_session) <= 64),
  to_user      uuid not null references public.profiles (id) on delete cascade,
  to_session   text not null check (char_length(to_session) <= 64),
  payload      jsonb not null,
  created_at   timestamptz not null default now()
);
create index signals_to_user_idx on public.signals (to_user);
create index signals_room_id_idx on public.signals (room_id);
create index signals_created_at_idx on public.signals (created_at);
create index signals_from_user_idx on public.signals (from_user);

alter table public.profiles     enable row level security;
alter table public.rooms        enable row level security;
alter table public.room_invites enable row level security;
alter table public.zones        enable row level security;
alter table public.room_members enable row level security;
alter table public.signals      enable row level security;
