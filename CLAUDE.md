# Sistema RPG — guia para quem for mexer no projeto

Plataforma de RPG de mesa online: o mestre cria uma sala, os jogadores entram
com um código de convite e todos conversam por voz, com **ambientes de áudio
separados**, cenas imersivas, música sincronizada e dados rolados no servidor.

- Site: https://sistema-rpg-livid.vercel.app
- Repositório: github.com/Daniel-Void/sistema-rpg
- Idioma de tudo (interface, commits, comentários): **português do Brasil**.

## Regras do dono do projeto (não mudar sem pedir)

- **Sem emojis** na interface. Ícones são SVG (`public/js/icons.js`).
- Visual escuro, sóbrio e imersivo: fontes Spectral + IBM Plex, acento `#c8553d`.
  Não deve parecer "feito por IA".
- Só administradores criam contas (e-mail e senha). Não há cadastro aberto nem
  usuário temporário: `create_temp_account` está sem permissão de execução.
- **Jogador não pede rolagem.** Só rola quando o mestre manda (`order_roll`).
- **Sussurro:** o jogador só *pede*; o mestre aceita ou força.
- Jogador vê **só o ambiente em que está**; o mestre vê todos e move jogadores.
- Áudio do mestre fica todo na aba **Música** (mixer). A aba Sons está escondida.
- Toda sala **vazia é excluída sozinha**: ninguém (mestre ou jogador) com a
  página aberta por 5 minutos.

## Arquitetura

- **Front-end estático** em `public/` (HTML + ES modules, sem build), servido
  pela Vercel. `vercel.json` reescreve `/sala/:id` → `/room`.
- **Supabase** (`toknaupmcfqhonsrpjct`, sa-east-1): Auth, Postgres com RLS,
  Realtime (canal privado `room:<id>` + `postgres_changes`), Storage (bucket
  privado `midia`, caminho `<roomId>/<arquivo>`), pg_cron.
  A chave em `public/js/config.js` é a *publishable* (pode ficar no navegador).
- **Funções da Vercel** em `api/`: `ice.js` entrega STUN/TURN (Cloudflare) só
  para usuários logados; `turn-status.js` + `_turnUsage.js` medem o consumo e
  cortam o TURN em 900 GB/mês (franquia grátis é 1000 GB).
- **Call:** WebRTC em malha (cada um conecta com cada um), "perfect negotiation",
  sinalização pela tabela `signals`. Transceivers em ordem fixa:
  0 = voz, 1 = vídeo da tela, 2 = áudio da tela. Quem ouve quem é decidido no
  envio com `replaceTrack` (regras em `audioRules.js`).
- **Toda ação importante é uma função do banco** (`security definer`, checa se é
  o mestre/participante). Helpers ficam no schema `private`
  (`is_room_master`, `is_room_participant`, `room_id_from_path`, `roll_dice`…).

### Arquivos principais

| Arquivo | O que tem |
|---|---|
| `public/js/room.js` | A sala inteira (~2.700 linhas): call, presença, cenas, mixer, dados, prévia do mestre, cards |
| `public/js/audioRules.js` | Quem ouve quem (ambientes, narração, sussurro) — puro, testado |
| `public/js/sceneRules.js` | Cena efetiva de cada ambiente, links do YouTube — puro, testado |
| `public/js/musicRules.js` | Posição/fim das faixas do mixer, faixas por ambiente — puro, testado |
| `public/js/dice.js` | Parser de dados (1d1 a 1000d1000, kh/kl/dh/dl, d%) — espelha o servidor |
| `public/js/painel.js` | Lista/cria/entra em salas; limpa arquivos de salas apagadas |
| `public/css/style.css` | Todo o visual (modo imersivo em `body.immersive`) |
| `supabase/migrations/` | Histórico do banco, com os mesmos nomes/versões do projeto remoto |

### Recursos e onde vivem

- **Ambientes de voz:** tabela `zones`; `rooms.master_target` diz com quem o
  mestre fala (todos, um ambiente ou um jogador).
- **Cenas imersivas:** imagem/vídeo + texto por ambiente (`set_environment`).
  O mestre vê como o jogador com "Ver como o jogador" (prévia local).
- **Mixer de música:** tabela `music_tracks` + `music_control` (play, pause,
  stop, seek, loop, chain, volume, ordem). Posição sincronizada pelo relógio do
  servidor (`server_now`). Atenção: `loop` é palavra reservada no PL/pgSQL —
  ler a coluna em variável, nunca `t.loop`.
- **Dados:** `private.roll_dice` sorteia no banco; tabela `dice_rolls`; animação
  com dados em SVG e som sintetizado para todos da mesa.
- **Sala vazia:** `room_heartbeat` a cada 30 s grava em `room_activity`;
  o job `apagar-salas-vazias` (pg_cron, todo minuto) chama
  `private.purge_empty_rooms()`.

## Como trabalhar

- Testes: `npm test` (node --test nas regras puras). Rodar antes de todo commit.
- Servidor local: `PORT=3998 node scripts/dev.js` (mesmas rotas da Vercel).
- Checar sintaxe do room.js: `npx acorn --ecma2022 --module public/js/room.js`.
- Testes de ponta a ponta: Playwright com Chromium em
  `/opt/pw-browsers/chromium-*/chrome-linux/chrome` e flags de mídia falsa.
  Contas de teste: `teste.mestre@`, `teste.ana@`, `teste.beto@`,
  `teste.caio@example.com`, todas com senha `segredo123`.
  O realtime pelo navegador do ambiente de nuvem costuma falhar
  ("transport failure"); quando isso acontecer, não é bug do site.
- **Banco:** toda mudança vira migração em `supabase/migrations/` com a mesma
  versão registrada no Supabase. O conector às vezes pede confirmação para
  `delete from`/alterar tabela existente; se expirar, perguntar ao dono.
  Código novo deve funcionar **antes e depois** de uma migração pendente.
- **Publicar:** o deploy de produção é manual pela Vercel (projeto
  `sistema-rpg`, a partir do branch de trabalho e do SHA do commit). Variáveis
  da Cloudflare ficam só na Vercel (secretas). Depois do deploy, conferir no
  site publicado que o arquivo novo está no ar.
- Commits pequenos, mensagens em português explicando o porquê.
