revoke execute on all functions in schema public from public, anon;
revoke all on public.profiles, public.rooms, public.room_invites, public.zones, public.room_members, public.signals from anon;
grant execute on function
  public.create_room(text, text),
  public.join_room(text),
  public.set_master_target(bigint, jsonb),
  public.move_player(bigint, uuid, bigint),
  public.create_zone(bigint, text),
  public.rename_zone(bigint, bigint, text),
  public.archive_zone(bigint, bigint),
  public.set_whisper(bigint, boolean),
  public.is_room_master(bigint),
  public.is_room_participant(bigint),
  public.is_user_in_room(bigint, uuid),
  public.room_id_from_topic(text)
to authenticated;
