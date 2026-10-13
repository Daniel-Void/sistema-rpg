-- O jogador não pede rolagens: só rola quando o mestre manda (order_roll/perform_roll).
revoke execute on function public.request_roll(bigint, text, text) from authenticated;
