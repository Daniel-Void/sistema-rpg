# 🎲 Sistema RPG

Plataforma de RPG online: mestres criam salas, jogadores entram com um código de convite, e todos conversam numa **call de voz com ambientes separados**.

- **Site:** hospedado na **Vercel** (arquivos estáticos em `public/`)
- **Banco, login e tempo real:** **Supabase** (Postgres + Auth + Realtime)
- **Áudio:** WebRTC direto entre os navegadores

## Funcionalidade 1: call com ambientes

Durante a sessão, o mestre divide o grupo em **ambientes** (ex.: *Fogueira*, *Floresta*):

| Situação | Quem ouve quem |
|---|---|
| Jogadores no mesmo ambiente | Se ouvem normalmente |
| Jogadores em ambientes diferentes | Não se ouvem |
| Mestre | Ouve **todos** os jogadores (com volume ajustável por ambiente) |
| Mestre falando com **Todos** | Todo mundo ouve o mestre |
| Mestre **narrando para um ambiente** | Só quem está naquele ambiente ouve. Os outros continuam conversando entre si normalmente |
| Mestre **sussurrando** para um jogador | Só aquele jogador ouve o mestre |
| Jogador segurando **"sussurrar"** (botão ou tecla `V`) | Só o mestre ouve o jogador |

Exemplo: o jogador 1 vai para a floresta. O mestre cria o ambiente *Floresta*, arrasta o jogador para lá e clica em **"Narrar só para este ambiente"**. Quem está na fogueira não ouve a narração e continua conversando entre si. `Esc` volta a falar com todos.

### Como funciona por dentro

```
Navegador ──(login, salas, ambientes, alvo do mestre)──▶ Supabase Postgres (com RLS)
    │                                                         │
    │◀──────────── mudanças ao vivo (Realtime) ───────────────┘
    │◀──────────── presença: quem está na call (canal privado "room:<id>")
    │
    └──── áudio direto (WebRTC P2P) ────▶ outros navegadores da sala
```

- **O estado da call fica no banco** (`rooms.master_target`, `room_members.zone_id`, `room_members.whisper_to_master`) e só pode ser alterado por funções que checam permissão (`create_room`, `move_player`, `set_master_target`, `set_whisper`…). Um jogador não consegue se mover de ambiente nem mudar o alvo do mestre.
- **Cada navegador calcula as regras** com `public/js/audioRules.js`, a partir desse estado confiável, e só **envia** o microfone para quem pode ouvir. Quem não deve ouvir não recebe o áudio, então não dá para burlar pelo navegador.
- **A sinalização do WebRTC** (offer/answer) vai pela tabela `signals`. O remetente é sempre o usuário logado e só o destinatário consegue ler, então ninguém se passa por outro jogador.
- **Presença** (quem está na call, microfone mudo) usa um canal Realtime privado, liberado só para os participantes da sala.

## Rodando localmente

Não tem build nem dependências: o front usa o `supabase-js` via CDN.

```bash
npm run dev     # http://localhost:3000 (servidor estático com as mesmas rotas da Vercel)
npm test        # testes das regras de áudio
```

Por padrão o site local usa o mesmo projeto Supabase de produção (`public/js/config.js`). Para testar sozinho, abra janelas anônimas diferentes, uma para cada conta.

## Configuração

### `public/js/config.js`

- `SUPABASE_URL` e `SUPABASE_KEY` (chave **publishable**, feita para ficar no navegador; quem protege os dados é o RLS).
- `ICE_SERVERS`: STUN/TURN da call. O STUN do Google resolve a maioria dos casos, mas jogadores em redes restritivas (4G, empresas) precisam de um **TURN** (ex.: Metered, Cloudflare, Twilio ou coturn próprio):

  ```js
  export const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:turn.seudominio.com:3478', username: 'usuario', credential: 'senha' },
  ];
  ```

### Supabase (painel)

- **Authentication → URL Configuration:** coloque a URL da Vercel em *Site URL* e em *Redirect URLs*, senão o link de confirmação do e-mail aponta para `localhost`.
- **Authentication → Sign In / Providers → Email:** a confirmação de e-mail está **ligada**. O e-mail padrão do Supabase tem limite baixo de envios por hora. Para uso real, configure um SMTP próprio, ou desligue "Confirm email" enquanto testa.
- **Realtime → Settings:** desligue **"Allow public access"** para que só canais privados (com as regras de acesso) sejam aceitos.

### Banco de dados

As migrações ficam em `supabase/migrations/`. Para recriar em outro projeto: `supabase link` + `supabase db push` (a migração `06` precisa do Realtime já inicializado: abra o site uma vez antes, ou rode-a depois).

Tabelas: `profiles` (nome e papel, criado no cadastro), `rooms`, `room_invites` (só o mestre lê), `zones`, `room_members`, `signals`.

## Limites atuais e próximos passos

- **Tamanho da mesa:** na malha P2P, cada pessoa manda seu áudio para cada outra. Funciona bem até umas **8 pessoas**. Para mais, o caminho é um servidor de mídia (SFU, ex.: LiveKit). As regras de `audioRules.js` continuam as mesmas.
- **Tempo de resposta:** mudar alguém de ambiente, trocar o alvo ou sussurrar leva de alguns décimos de segundo a ~1s para valer, porque passa pelo banco.
- Ideias para as próximas funcionalidades: fichas de personagem, rolagem de dados, chat por ambiente, mapa, música ambiente por ambiente.

## Estrutura

```
public/
  index.html, painel.html, room.html
  js/config.js       # URL/chave do Supabase e servidores ICE
  js/supabase.js     # cliente Supabase + utilitários
  js/audioRules.js   # regras de quem ouve quem
  js/room.js         # call: presença, sinalização, WebRTC, controles
scripts/dev.js       # servidor local
supabase/migrations/ # esquema, RLS e funções do banco
vercel.json          # rotas (/sala/:id) e cabeçalhos
test/                # testes (node:test)
```
