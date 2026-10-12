alter policy "só o destinatário lê o sinal" on public.signals
  using (to_user = (select auth.uid()) or from_user = (select auth.uid()));
alter policy "só o destinatário lê o sinal" on public.signals rename to "remetente e destinatário leem o sinal";
