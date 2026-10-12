revoke execute on function public.handle_new_user() from authenticated, anon, public;

create schema if not exists private;
grant usage on schema private to authenticated;

alter function public.is_room_master(bigint) set schema private;
alter function public.is_room_participant(bigint) set schema private;
alter function public.is_user_in_room(bigint, uuid) set schema private;
alter function public.room_id_from_topic(text) set schema private;

grant execute on function
  private.is_room_master(bigint),
  private.is_room_participant(bigint),
  private.is_user_in_room(bigint, uuid),
  private.room_id_from_topic(text)
to authenticated;
