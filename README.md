# 🎲 Sistema RPG

Plataforma de RPG online: mestres criam salas, jogadores entram com um código de convite, e todos conversam numa **call de voz com ambientes separados**. O mestre controla o que cada ambiente vê e ouve (cenas, som ambiente e efeitos) e pode compartilhar a tela.

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
| **Sussurro** (conversa particular) | O mestre e o jogador só se ouvem entre si; o jogador continua ouvindo o próprio ambiente |

**Quem controla o sussurro é o mestre.** O jogador só pode **pedir** ("Pedir para falar com o mestre") ou cancelar o pedido. O mestre recebe o aviso e **aceita** ou **recusa**, e também pode **forçar** o sussurro com qualquer jogador, sem pedido. Só o mestre encerra. Um sussurro novo encerra o anterior.

Exemplo: o jogador 1 vai para a floresta. O mestre cria o ambiente *Floresta*, arrasta o jogador para lá e clica em **"Narrar só para este ambiente"**. Quem está na fogueira não ouve a narração e continua conversando entre si. `Esc` volta a falar com todos.

## Funcionalidade 2: compartilhamento de tela

O mestre clica em **Compartilhar tela** na barra superior e escolhe para quem: **Todos** ou um **ambiente** específico. **O som também vai junto**: ao compartilhar uma aba no Chrome/Edge, marque "Compartilhar áudio da aba" (ótimo para mostrar um vídeo ou uma música). A própria aba do site não aparece na lista, para evitar o efeito espelho. Compartilhar exige computador; no celular dá para assistir, não para compartilhar. A tela aparece no palco dos jogadores escolhidos. Quem não está no alvo não recebe nenhum quadro de vídeo. Dá para trocar o alvo durante o compartilhamento.

## Funcionalidade 3: ambientes imersivos, música e efeitos

**Para o jogador, a tela inteira vira o ambiente em que ele está.** A imagem do ambiente ocupa o fundo da página, com um movimento lento de câmera, bordas escurecidas e uma leve textura de cinema. A interface (pessoas, ambientes, controles) flutua por cima em painéis translúcidos, deixando o centro da cena livre. Ao chegar num ambiente, o nome do lugar aparece em destaque e some; o texto da cena fica flutuando sobre a imagem. Quando o mestre move o jogador, a cena troca com um esmaecimento suave. A tecla `H` (ou o ícone de olho) esconde a interface inteira para ver só o ambiente.

Na aba **Cena**, o mestre escolhe o ambiente (ou a **cena padrão**, para quem estiver em ambiente sem cena própria) e define:

- **Imagem do ambiente:** enviada por ele para a biblioteca da sala (até 50 MB; vídeo em loop também funciona).
- **Música do ambiente:** um **link do YouTube** (vídeo ou playlist), que toca em loop, só o áudio, para quem estiver naquele ambiente. O campo avisa se o link não for do YouTube.
- **Texto na tela** e **volume** da música.

O ícone de imagem no card do ambiente abre a cena dele direto. Cada jogador tem um controle de volume e um botão para silenciar a música. Se o navegador bloquear o som automático, aparece "Toque para ativar a música".

Na aba **Sons**, o mestre dispara **efeitos sonoros** (áudios enviados para a biblioteca) para todos, para um ambiente ou para um jogador. **Parar efeitos** corta tudo.

> A música é tocada pelo player do YouTube em cada navegador (não fica sincronizada entre os jogadores). Vídeos cujo dono proíbe a reprodução fora do YouTube mostram "Este vídeo não permite tocar aqui"; nesse caso, escolha outro link.

## Funcionalidade 4: dados

**Quem sorteia é o servidor (banco de dados), nunca o navegador.** Nenhum jogador consegue escolher ou falsificar o resultado.

| Quem | O que faz |
|---|---|
| **Jogador** | Escreve a rolagem (ou usa os botões d4…d100), põe um motivo opcional e clica em **Pedir ao mestre para rolar**. Pode cancelar o pedido. |
| **Mestre** (aba **Dados**) | Vê os pedidos com contador, pode **ajustar a expressão**, marcar como **secreta** e **Aprovar** ou **Recusar**. |
| **Mestre rolando** | Escolhe "Quem rola: Eu (mestre)" e clica em **Rolar**, aberto ou **secreto**. |
| **Mestre mandando rolar** | Escolhe um jogador em "Quem rola" (ex.: Jogador 1, `2d20`, "Teste de Força") e clica em **Mandar rolar**. O pedido aparece na tela do jogador com um botão **Rolar**. O mestre pode cancelar enquanto o jogador não rola. |

O resultado aparece na tela de todos: **dados desenhados (d4, d6, d8, d10, d12, d20, d100 e os demais) entram rolando, quicam e giram com os números trocando, com som de batida na mesa a cada quique**, e param exatamente nos valores sorteados pelo banco. Dados descartados ficam apagados, máximos brilham e 1 fica vermelho; em seguida aparece o total. Rolagens **secretas** só aparecem para o mestre e para quem rolou. Cada rolagem fica no histórico, com cada dado mostrado: os descartados aparecem riscados, os máximos em verde e os 1 em vermelho.

**Notação aceita** (de `1d1` até `1000d1000` em cada termo):

| Exemplo | Significado |
|---|---|
| `1d20`, `d20` | um dado de 20 lados |
| `3d6+1d4-2` | soma e subtrai dados e números |
| `d%` | o mesmo que `d100` |
| `2d20kh1` | rola 2 e fica com o maior (vantagem) |
| `2d20kl1` | rola 2 e fica com o menor (desvantagem) |
| `4d6dl1` | rola 4 e descarta o menor |
| `4d6dh1` | rola 4 e descarta o maior |

Limites: até 20 termos e 5000 dados por rolagem. Enquanto você digita, aparece uma prévia ("2 dados de 20 lados (fica com o maior), mais 3. Resultado entre 4 e 23.") ou o motivo do erro.

> A estrutura já está pronta para os **testes** (dificuldade, sucesso/falha, perícias etc.) que serão definidos depois: cada rolagem guarda quem rolou, o motivo, a expressão e todos os dados sorteados.

## Acesso de teste (usuários temporários)

Enquanto a criação de contas não fica restrita aos administradores, a tela inicial cria um **usuário temporário** só com nome e papel (mestre ou jogador), sem e-mail e sem senha. O usuário fica salvo naquele navegador, então cada aparelho cria o seu. Por dentro, a função `create_temp_account` cria uma conta com e-mail interno e uma senha aleatória gerada no navegador (limite de 30 contas por minuto). O link "Entrar com e-mail e senha" continua disponível para contas normais.

### Como funciona por dentro

```
Navegador ──(login, salas, ambientes, alvo do mestre)──▶ Supabase Postgres (com RLS)
    │                                                         │
    │◀──────────── mudanças ao vivo (Realtime) ───────────────┘
    │◀──────────── presença: quem está na call (canal privado "room:<id>")
    │
    └──── áudio direto (WebRTC P2P) ────▶ outros navegadores da sala
```

- **O estado da call fica no banco** (`rooms.master_target`, `room_members.zone_id`, `room_members.whisper_to_master`, `room_members.whisper_requested`) e só pode ser alterado por funções que checam permissão (`create_room`, `move_player`, `set_master_target`, `request_whisper`, `start_whisper`, `end_whisper`…). Um jogador não consegue se mover de ambiente nem mudar o alvo do mestre.
- **Cada navegador calcula as regras** com `public/js/audioRules.js`, a partir desse estado confiável, e só **envia** o microfone para quem pode ouvir. Quem não deve ouvir não recebe o áudio, então não dá para burlar pelo navegador.
- **A sinalização do WebRTC** (offer/answer) vai pela tabela `signals`. O remetente é sempre o usuário logado e só o destinatário consegue ler, então ninguém se passa por outro jogador.
- **Presença** (quem está na call, microfone mudo, se o mestre está compartilhando a tela) usa um canal Realtime privado, liberado só para os participantes da sala.
- **Tela compartilhada:** cada conexão tem um canal de vídeo além do de voz, e o mestre só envia a tela para quem está no alvo.
- **Arquivos** ficam no bucket privado `midia` do Supabase Storage (`<id da sala>/<arquivo>`). Só o mestre envia ou apaga, só participantes leem, por links temporários.
- **Efeitos sonoros** são mensagens *broadcast* no canal da sala, e só o mestre tem permissão para enviá-las.

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

Tabelas: `profiles` (nome e papel, criado no cadastro), `rooms`, `room_invites` (só o mestre lê), `zones`, `room_members`, `signals`, `room_media` (biblioteca), `dice_rolls` (rolagens). As colunas `scene_media_id`, `scene_caption`, `ambient_youtube` e `ambient_volume` em `zones` e `rooms` guardam as cenas (gravadas pela função `set_environment`).

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
  js/sceneRules.js   # cena de cada ambiente e alvos de efeitos/tela
  js/dice.js         # leitura e prévia da notação de dados
  js/icons.js        # ícones em SVG
  js/room.js         # call, tela, cenas, efeitos e controles
scripts/dev.js       # servidor local
supabase/migrations/ # esquema, RLS e funções do banco
vercel.json          # rotas (/sala/:id) e cabeçalhos
test/                # testes (node:test)
```
