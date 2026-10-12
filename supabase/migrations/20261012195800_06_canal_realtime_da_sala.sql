-- Requer o Realtime já inicializado no projeto (a tabela realtime.messages é criada na primeira conexão).
create policy "participantes leem o canal da sala" on realtime.messages
  for select to authenticated
  using (realtime.messages.extension in ('presence', 'broadcast')
         and public.is_room_participant(public.room_id_from_topic((select realtime.topic()))));

create policy "participantes publicam no canal da sala" on realtime.messages
  for insert to authenticated
  with check (realtime.messages.extension in ('presence', 'broadcast')
              and public.is_room_participant(public.room_id_from_topic((select realtime.topic()))));
