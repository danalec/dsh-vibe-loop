# dsh-vibe-agent

[English](README.md) | Português (BR)

Roda o agente [Mistral Vibe](https://console.mistral.ai/) (`vibe-acp`, via o
[Agent Client Protocol](https://agentclientprotocol.com)) como o loop de agente
dentro do [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
([`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)): um
plugin `Agent` do DSH que conduz um processo filho `vibe-acp` headless, então o
frontend do DSH — log de sessão, hooks, presets, web UI — funciona sem
mudança.

```
Frontend do DSH (sessões, hooks, presets, persistência JSONL, web UI)
        │
dsh-vibe-agent  (este plugin: AgentFactory + tradução de eventos + vínculo de sessão)
        │  spawn + JSON-RPC over stdio
        │  initialize / session/new / session/load / session/prompt / session/cancel
        ▼
vibe-acp   (o agente Mistral Vibe, intocado)
```

## Por quê

O Vibe é o agente de código da Mistral: uma caixa de ferramentas completa, a
família de modelos da Mistral e as skills instaladas com ele. Este plugin
coloca o Vibe atrás do frontend do DSH, então a conversa fica durável, o log
de sessão é inspecionável, hooks e presets funcionam, e tudo roda na mesma
web UI das demais sessões do DSH.

É o irmão do [dsh-pi-loop](https://github.com/danalec/dsh-pi-loop): mesmo
contrato (um `AgentFactory` do DSH), mesmo vocabulário de eventos, mesmo
ciclo de vida de sessão — outro motor por trás.

## O que muda e o que não muda

| Camada | Comportamento |
| --- | --- |
| Roteamento de modelo | ids de modelo do Vibe (`mistral-large-4-0-3`); a opção de modelo da sessão é ajustada por `session/set_config_option`. Um modelo que a sessão não oferece falha alto, em vez de rodar outro silenciosamente |
| Execução de ferramentas | as ferramentas rodam dentro do Vibe. O log do DSH as registra (`tool/call`, `tool/result`) conforme acontecem, mas elas não passam pela superfície de tools do DSH |
| Permissões | o Vibe pergunta antes de rodar uma ferramenta (`session/request_permission`). O plugin responde **uma chamada por vez** (`allow-once`, o padrão) ou recusa (`deny`); concessão permanente nunca é dada |
| Steering | ACP não tem steering no meio da execução. Uma mensagem `next-step` fica na fila e é entregue com o próximo prompt — nada se perde, mas ela não interrompe o turno em andamento |
| Persistência de sessão | os eventos de sessão do DSH continuam sendo a fonte durável da verdade; o id da sessão Vibe fica num sidecar (`~/.dsh/vibe-sessions/<session-id>.json`) para o resume recarregar a mesma conversa |
| Fallback | desabilite a entrada deste plugin e reabilite o `agent-loop`: o `dsh-agent-loop` do próprio DSH volta a valer. Só um factory pode ocupar o slot de agente, então as duas entradas são mutuamente exclusivas |

## Mapeamento de fronteiras

| DSH | Vibe (ACP) |
| --- | --- |
| um turno | um `session/prompt` (uma execução do Vibe) |
| um step | um turno de assistant (uma chamada de modelo + as tools que ela rodou) |
| fronteira de step | a resposta do `session/prompt` (o turno terminou) |
| entrada de next-step | fica na fila para o próximo prompt (ACP não tem steering no meio da execução) |

## Handoff no meio da sessão

Uma sessão do DSH não precisa nascer sob o Vibe para ser conduzida por ele. O
resume recarrega a sessão Vibe usada antes (`session/load`), então a conversa
continua exatamente onde parou: o modelo mantém o contexto que tinha, não uma
aproximação reconstruída.

- O DSH continua sendo a fonte da verdade para o frontend; o id da sessão
  Vibe fica num sidecar em `~/.dsh/vibe-sessions/`.
- Quando a sessão Vibe sumiu (ou o agente não anuncia `loadSession`), o plugin
  inicia uma sessão Vibe nova e avisa no diagnóstico — o log do DSH continua
  mostrando toda a história, mas o contexto do modelo começa vazio.

## Compatibilidade

O plugin implementa a API de agente do DSH **0.2**, desenvolvido e testado
contra o **DSH 0.2.2-rc.3**; a faixa de peer publicada aceita qualquer
`0.2.2-rc.x` dessa linha.

| API do DSH | O que o plugin faz |
| --- | --- |
| `ctx.agents.setFactory` | registra a fábrica do Vibe de forma síncrona, então uma sessão criada logo após a montagem já encontra a fábrica |
| `Agent.inbox` | o driver é dono da entrada pendente (`src/inbox.ts`); no DSH 0.2 `Inbox` virou interface estrutural e a implementação pertence ao driver |
| `Agent.model` | o driver é dono da escolha durável de modelo (`src/model.ts`) |
| `CreateAgentOptions.meta` | o `cwd` e a linhagem de fork da sessão viajam como metadados da sessão |
| `ctx.agents.enter(agent)` | o agente entra no registro só com o agente — o elo com o pai é dado da sessão |
| `agent/created` | o registro anuncia o agente com a origem da sessão (`startup` / `resume`) |
| `agent/assistant-stream` | os frames de início/chunk/fim de uma tentativa do assistant |
| `assistant/message` | carrega o stream do provedor dentro do evento (`stream`), mais o uso de tokens que o Vibe reporta |
| `tool/call` / `tool/result` | as chamadas de ferramenta do Vibe, como o ACP as relata |
| persistência de sessão | `persistence.create()` / `persistence.open(id, 'write')` são donos do log armazenado |

## Requisitos

- Node.js ≥ 20
- [Mistral Vibe](https://console.mistral.ai/) instalado e autenticado — o
  executável `vibe-acp` precisa estar no `PATH` (o instalador da Mistral o
  coloca lá). No Windows é um shim `.cmd`/`.exe`; o plugin o resolve e o roda
  via `cmd.exe` com todos os argumentos entre aspas.
- [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) ≥ `0.2.2-rc.3` com um
  profile expondo os serviços `sessions`, `agents` e `sessionProjections`
- Deps de peer: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`,
  `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-scope`, `@deepseek-ai/dsh-session`,
  `@deepseek-ai/dsh-session-persistence`, `@deepseek-ai/dsh-session-projection`

## Instalação

O pacote não está no registry do npm, então instale direto da árvore de
fonte. O gerenciador de plugins do profile repassa para o pnpm, então um
checkout local é instalado como qualquer outra dependência:

```bash
# Linka a árvore de trabalho: o profile sempre roda seu checkout (recompile e
# reinicie o DSH). Este é o setup de desenvolvimento.
dsh plugin --profile desktop add link:/path/to/dsh-vibe-agent

# Ou instala uma cópia do diretório (o que `npm pack` produziria).
dsh plugin --profile desktop add file:/path/to/dsh-vibe-agent
```

## Uso

Monte no patch layer do profile (`cordis.patch.yml`). Um plugin novo é
montado com uma lista `insert:` — uma entrada `- id:` só sobrescreve uma
entrada que já existe:

```yaml
# O loop do próprio DSH ocupa o slot de agent-factory e só um factory pode
# estar registrado, então a entrada nativa sai de cena enquanto o Vibe entra.
- id: agent-loop
  disabled: true

- insert:
    - id: vibe-loop
      name: 'dsh-vibe-agent'
      config:
        vibePath: 'vibe-acp'            # ou um caminho absoluto
        cwd: '/path/to/your/project'    # diretório de trabalho das sessões Vibe
        model: 'mistral-large-4-0-3'    # o id de modelo do Vibe
        pinModel: true
        permission: 'allow-once'        # como responder aos pedidos de permissão
        debug: false

# Voltar ao loop do DSH: desabilite esta entrada e reabilite o agent-loop.
# - id: vibe-loop
#   disabled: true
```

### Config

| Chave | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `vibePath` | `string` | `'vibe-acp'` | executável `vibe-acp`; resolvido pelo `PATH` |
| `vibeArgs` | `string[]` | `[]` | argumentos extras passados ao executável |
| `cwd` | `string` | `process.cwd()` | diretório de trabalho das sessões Vibe |
| `model` | `string` | — | id de modelo do Vibe (por exemplo `mistral-large-4-0-3`) |
| `pinModel` | `boolean` | `false` | sempre usar `model`, ignorando a rota pedida pelo DSH |
| `permission` | `'allow-once' \| 'deny'` | `'allow-once'` | como responder aos pedidos de permissão de tool; concessão permanente nunca é dada |
| `debug` | `boolean` | `false` | anexa diagnósticos do protocolo em `<tmpdir>/dsh-vibe-agent.log` |

## Ciclo de vida da sessão

| Fase | O que acontece |
| --- | --- |
| create | a sessão é preparada, o backend assume a escrita do log, uma sessão Vibe é criada (`session/new`), a opção de modelo é aplicada e o id da sessão ACP vai para o sidecar |
| turn | a entrada é reivindicada na inbox, o prompt vai para o Vibe (`session/prompt`), os updates do Vibe viram eventos de sessão do DSH e o backend os armazena |
| resume | o log armazenado volta, um turno interrompido é fechado duravelmente, a sessão Vibe é recarregada (`session/load`) e o próximo prompt continua essa conversa |
| dispose | o filho é parado, o scope é desfeito e o handle de persistência é fechado |

## Notas de plataforma

- **Windows**: o `vibe-acp` é instalado como shim de comando. O plugin
  resolve o shim (`.exe`/`.com`/`.cmd`/`.bat`) e roda `.cmd`/`.bat` via
  `cmd.exe` com todos os argumentos entre aspas. Aponte `vibePath` para o
  shim se ele não estiver no `PATH`.
- **POSIX**: o executável é rodado direto.
- O arquivo de diagnóstico fica no temp do sistema (`os.tmpdir()`), então é
  gravável em qualquer plataforma.

## Troubleshooting

| Sintoma | Causa | Correção |
| --- | --- | --- |
| `patch: entry "vibe-loop" not found` | a entrada é um override `- id:` em vez de `insert:` | envolva em `- insert:` |
| `an agent factory is already registered` | o `agent-loop` do DSH ainda segura o slot | desabilite o `agent-loop` na mesma camada |
| `no agent factory registered (load an agent-loop plugin)` | o plugin não montou (nome errado, ou o profile não tem `agent-loop` nem `vibe-loop`) | confira o `name:` da entrada e os diagnósticos do loader |
| `vibe-acp process failed to start` | o executável não está no `PATH` | aponte `vibePath` para o caminho absoluto |
| `vibe session does not offer the model "…"` | o id de modelo não é um dos que a sessão oferece | veja os ids que o Vibe lista para a opção `model` |
| O turno retomado não tem contexto | a sessão Vibe sumiu e uma nova foi iniciada | veja o diagnóstico: `session] loaded` ou `session] new` |
| Sem diagnósticos | `debug` está desligado | ligue `debug: true` e leia `%TEMP%/dsh-vibe-agent.log` |

## Desenvolvimento

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # compila e roda a suíte node:test
npm run build       # atualiza dist/ — é o que o profile carrega
```

O `package.json` fixa os pacotes `@deepseek-ai/dsh-*` em `0.2.2-rc.3` por um
bloco `overrides`: os pacotes do DSH pinam o peer dos outros numa versão exata,
então uma árvore misturada não resolve.

`tools/dsh-e2e.mjs` roda o ciclo completo contra os pacotes reais do DSH:
monta o plugin num contexto mínimo, cria uma sessão, manda um prompt, descarta,
retoma do log armazenado e manda um segundo prompt. Ele usa o agente falso por
padrão (não gasta plano Mistral):

```bash
node tools/dsh-e2e.mjs          # hermético: o vibe-acp falso
node tools/dsh-e2e.mjs --real   # o vibe-acp instalado (usa o plano)
```

## Licença

Duplamente licenciada, à sua escolha: **MIT** ou **Apache-2.0**
(`MIT OR Apache-2.0`). As duas são completas e gratuitas nos seus próprios termos.

O Apache-2.0 é a escolha melhor para redistribuição corporativa: além da
licença ampla de direitos autorais, ele concede uma licença de patentes (seção 3)
que termina se você iniciar litígio de patente contra o detentor dos direitos
autorais. O MIT é o mais permissivo dos dois — mais curto, sem concessão
expressa de patentes, sem arquivo NOTICE.

Suporte, garantias e indenizações não são concedidos por nenhuma das duas
licenças. Isso é um acordo separado com o detentor dos direitos autorais, não
uma terceira opção de licença.

Textos completos: [`LICENSE`](LICENSE), [`LICENSE-MIT`](LICENSE-MIT),
[`LICENSE-APACHE`](LICENSE-APACHE).
