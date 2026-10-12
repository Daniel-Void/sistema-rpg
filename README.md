# 🎲 Sistema RPG

Plataforma de RPG online: mestres criam salas, jogadores entram com um código de convite, e todos conversam numa **call de voz com ambientes separados**.

## Funcionalidade 1 — Call com ambientes

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

Exemplo: o jogador 1 vai para a floresta. O mestre cria o ambiente *Floresta*, arrasta o jogador para lá e clica em **"Narrar só para este ambiente"**. Quem está na fogueira não ouve a narração e continua conversando entre si. Quando quiser, o mestre aperta `Esc` e volta a falar com todos.

Para os jogadores, a tela mostra em que ambiente eles estão, quem estão ouvindo e se o mestre está falando com eles (todos, o ambiente deles ou em particular). Para onde o mestre está narrando fica oculto para quem não está ouvindo.

### Como a separação funciona (e por que não dá para "espiar")

- O áudio vai direto de um navegador para o outro (WebRTC, conexão P2P entre todos da sala).
- A cada mudança (mover jogador, trocar o alvo do mestre, sussurro), o **servidor** recalcula as regras (`server/audioRules.js`) e diz a cada participante para quem ele pode **enviar** o microfone.
- Quem não deve ouvir **não recebe o áudio**: o microfone nem chega até ele. Não é só um "mudo" na tela, então não dá para burlar pelo navegador.

## Outras funcionalidades

- Cadastro e login (escolhendo **mestre** ou **jogador**), sessão por cookie seguro (HttpOnly).
- Mestres criam e excluem salas; cada sala tem um **código de convite**.
- Jogadores entram com o código; o mestre pode remover jogadores.
- Criar, renomear e excluir ambientes ao vivo; mover jogadores arrastando ou pelo seletor (funciona no celular).
- Indicador de quem está falando, botão de mutar microfone, status de conexão.
- Ambientes e posições dos jogadores ficam salvos no banco.

## Rodando localmente

Requer **Node.js 22.13+** (o banco usa o SQLite embutido do Node, sem instalar nada extra).

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # reinicia sozinho ao editar arquivos
npm test           # testes das regras de áudio, API e servidor de voz
```

Para testar sozinho, abra janelas anônimas diferentes (ou navegadores diferentes), cada uma logada com um usuário.

### Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `PORT` | Porta do servidor (padrão `3000`) |
| `SESSION_SECRET` | Segredo para assinar os logins. Se não definir, um é gerado em `data/.session-secret` |
| `DB_FILE` | Caminho do banco SQLite (padrão `data/rpg.db`) |
| `ICE_SERVERS` | Servidores STUN/TURN em JSON (veja abaixo) |
| `NODE_ENV=production` | Marca o cookie de login como `Secure` (exige HTTPS) |

## Colocando no ar

1. **HTTPS é obrigatório**: o navegador só libera o microfone em `https://` (ou em `localhost`).
2. **Servidor TURN**: o STUN padrão (Google) resolve a maioria das conexões, mas jogadores atrás de redes restritivas (4G, redes corporativas) precisam de um TURN. Opções: [coturn](https://github.com/coturn/coturn) no seu servidor, ou serviços como Metered/Twilio/Cloudflare. Configure assim:

   ```bash
   ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.seudominio.com:3478","username":"usuario","credential":"senha"}]'
   ```
3. Use uma hospedagem que mantenha um processo Node rodando com WebSocket (Render, Railway, Fly.io, VPS). Plataformas só "serverless" (como Vercel) não servem para o servidor de sinalização.

## Limites atuais e próximos passos

- **Tamanho da mesa**: na conexão P2P, cada pessoa manda seu áudio para cada outra. Funciona bem até umas **8 pessoas**, o que cobre a maioria das mesas de RPG. Para mesas maiores ou streaming, o caminho é trocar a malha P2P por um servidor de mídia (SFU, ex.: [LiveKit](https://livekit.io) ou mediasoup). As regras de `audioRules.js` continuam as mesmas, só muda quem aplica.
- Ideias para as próximas funcionalidades: fichas de personagem, rolagem de dados, chat de texto por ambiente, mapa/tabuleiro, música ambiente por ambiente, vídeo.

## Estrutura

```
server/
  index.js       # sobe Express + Socket.IO
  db.js          # tabelas SQLite
  store.js       # consultas ao banco
  auth.js        # senhas (scrypt) e sessões assinadas
  api.js         # rotas REST: cadastro, login, salas
  voice.js       # sinalização WebRTC + estado ao vivo da call
  audioRules.js  # regras de quem ouve quem
public/
  index.html     # login / cadastro
  painel.html    # lista de salas, criar, entrar com código
  room.html      # a sala com a call
  js/room.js     # WebRTC, controles do mestre e do jogador
test/            # testes (node:test)
```
