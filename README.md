# dsh-vibe-loop

English | [Português (BR)](README.pt-BR.md)

Run the [Mistral Vibe](https://console.mistral.ai/) agent (`vibe-acp`, over the
[Agent Client Protocol](https://agentclientprotocol.com)) as the agent loop
inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
([`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)): a DSH
`Agent` plugin that drives a headless `vibe-acp` child process, so DSH's
frontend — session log, hooks, presets, web UI — works unchanged.

```
DSH frontend (sessions, hooks, presets, JSONL persistence, web UI)
        │
dsh-vibe-loop  (this plugin: AgentFactory + event translation + session link)
        │  spawn + JSON-RPC over stdio
        │  initialize / session/new / session/load / session/prompt / session/cancel
        ▼
vibe-acp   (the Mistral Vibe agent, untouched)
```

## Why

Vibe is Mistral's coding agent: a full toolbox, the Mistral model family and
the skills installed with it. This plugin puts it behind DSH's frontend, so
the conversation is durable, the session log is inspectable, the hooks and
presets work, and the whole thing runs in the same web UI as every other DSH
session.

It is the sibling of [dsh-pi-loop](https://github.com/danalec/dsh-pi-loop):
same contract (a DSH `AgentFactory`), same event vocabulary, same session
lifecycle — a different engine behind it.

## What changes vs. what doesn't

| Layer | Behavior |
| --- | --- |
| Model routing | Vibe's own model ids (`mistral-large-4`); the session's model option is set through ACP's `session/set_config_option`. A model the session does not offer fails loudly instead of silently running another one |
| Tool execution | the tools run inside Vibe. DSH's log records them (`tool/call`, `tool/result`) as they happen, with Vibe's own tool name (`read_file`, `write_file`, …) and its real output — but they do not pass through DSH's tool surface |
| Permissions | the session runs in Vibe's `ask` mode, so every tool run is a question. The plugin routes it through **DSH's own approval chain** (`permission: 'dsh'`, the default): the session's approval policy applies and the UI answerer decides. `allow-once` approves the single call; `deny` refuses it. A standing grant is never given |
| Images | a DSH user message may carry images; their bytes are read through the attachment store and sent as ACP image blocks |
| Steering | ACP has no mid-run steering. A `next-step` message is queued and delivered with the next prompt, in the same turn — nothing is lost, but it does not interrupt the running turn |
| Session persistence | DSH's session events remain the durable source of truth; the Vibe session id is kept in a sidecar (`~/.dsh/vibe-sessions/<session-id>.json`) so a resume reloads the same Vibe conversation |
| Fallback | Disable this plugin's entry and re-enable `agent-loop`: DSH's own `dsh-agent-loop` becomes active again immediately. Only one factory may hold the agent slot at a time, so the two entries are mutually exclusive |

## Boundary mapping

| DSH | Vibe (ACP) |
| --- | --- |
| one turn | one `session/prompt` (one Vibe run) |
| one step | one assistant turn (one model call plus the tools it ran) |
| step boundary | the `session/prompt` response (the turn ended) |
| next-step input | queued for the next prompt (ACP has no mid-run steering) |

## DSH agent hooks

The plugin implements the agent-subject events the frontend and the policy
chain rely on:

| Event | Behavior |
| --- | --- |
| `agent/status` | `idle` ⇄ `running`, mirrored on every transition |
| `agent/inbox/inserted` / `claimed` / `discarded` | the pending input is **claimed** when it enters a step (never recorded as a cancellation) |
| `agent/pre-step` | dispatched before each step; a `reject` blocks the turn (`turn/end` reason `blocked`) and Vibe is never prompted |
| `agent/turn-stopping` | dispatched at the turn's stop boundary |
| `agent/created` | the registry announces the agent with `source: 'startup'` for a fresh session, `'resume'` for a persisted one |
| `agent/assistant-stream` | the start/chunk/end frames of one assistant attempt, published live |
| `agent/error` | reported at the live boundary; the turn still closes with an error reason |

## Mid-session handoff

A DSH session does not have to be born under Vibe to be driven by it. Resuming
a session through this plugin reloads the Vibe session it used before
(`session/load`), so the conversation continues exactly where it stopped: the
model keeps the context it had, not a rebuilt approximation of it.

- DSH remains the source of truth for the frontend; the Vibe session id lives
  in a sidecar under `~/.dsh/vibe-sessions/`.
- When the Vibe session is gone (or the agent does not advertise
  `loadSession`), the plugin starts a fresh Vibe session and hands it the
  conversation DSH's log holds — rendered as a transcript, delivered with the
  first prompt. The model then continues from the history instead of starting
  blind, and the diagnostics say which path was taken (`session] loaded` vs
  `session] new`).

## Subagents on Vibe

The Vibe agent is also a delegable engine: each accepted run spawns a fresh
`vibe-acp`, opens a session in the delegating session's workspace, sends the
task as one prompt and returns the final answer.

```yaml
- insert:
    - id: subagent-vibe
      name: 'dsh-vibe-loop/subagent'
      config:
        providerName: vibe
        vibePath: 'vibe-acp'
        model: 'mistral-large-4'
        timeoutMs: 600000

- insert:
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: vibe          # 'spawn'/'fork' for DSH-native children
        toolName: subagent
        backgroundMode: one-shot
        maxDepth: 'provider-managed'
```

The child is a bare Vibe agent: its own system prompt, its own tools, its own
skills. Nothing from the parent conversation, persona, or tool surface crosses
the process boundary.

## Two engines in one profile

DSH has a single agent-factory slot, so two engine plugins cannot both drive
sessions. The way to run both is a **router**: it owns the slot and delegates
per session, and the session's **agent preset** decides which engine runs it.

The preset is the DSH's own durable record of the choice — it lands in the
session header (`agentPreset`), in the session log (`agent-preset/selected`)
and in the `agentPreset` projection. A session that resumes picks the engine
it was created with, even if the configuration changed in between.

`profile/loop-router.mjs` is that router. It is a plain file rather than a
package because it imports both engines, and a file inside the profile
resolves them from the profile's `node_modules` (where both plugins are
linked):

```yaml
# ~/.dsh/profiles/desktop/dsh/loop-router.mjs  ->  imports dsh-pi-loop and dsh-vibe-loop
- insert:
    - id: loop-router
      name: 'file:///C:/Users/danalec/.dsh/profiles/desktop/dsh/loop-router.mjs'
      config:
        presets:
          coding:
            engine: pi        # heavy coding -> the Pi loop
            model: 'anthropic/claude-sonnet-4-5'  # the model this preset runs on
            thinking: 'high'  # the thinking level it runs on
          coding-leve:
            engine: vibe     # light coding -> the Mistral Vibe loop
            model: 'mistral-large-4'
        default: vibe
        pi:
          piPath: 'C:\\Users\\danalec\\.pi\\agent\\bin\\pi.cmd'
          model: 'anthropic/claude-sonnet-4-5'
          pinModel: true
        vibe:
          vibePath: 'C:\\Users\\danalec\\AppData\\Local\\Microsoft\\WinGet\\Links\\vibe-acp.exe'
          model: 'mistral-large-4'
          pinModel: true
          permission: 'dsh'
          mode: 'ask'
```

A preset names the engine, and optionally the model its sessions run on:
`{ engine: pi, model: 'zai/glm-5.3-flash' }`. The model belongs to the
preset, so the route travels with the preset's decision; the engine's own
`model:` stays the default for a preset that names none.

A preset may also name the `thinking` level its sessions run on. The
level is Pi's: a Vibe session has no such setting, so a Vibe preset's
thinking is ignored.

The presets themselves compose the delegation tool that runs the *other*
engine in the background — that is the parallel path: a session on one loop
hands work to the other while it keeps going.

```yaml
- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: coding-leve
    - id: preset-coding
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: coding
        name: 'Coding (Pi)'
        plugins:
          - id: tool-subagent-vibe
            name: '@deepseek-ai/dsh-tool-subagent'
            config:
              provider: vibe
              toolName: subagent-vibe
              backgroundMode: one-shot
              maxDepth: 'provider-managed'
    - id: preset-coding-leve
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: coding-leve
        name: 'Coding leve (Vibe)'
        plugins:
          - id: tool-subagent-pi
            name: '@deepseek-ai/dsh-tool-subagent'
            config:
              provider: pi
              toolName: subagent-pi
              backgroundMode: one-shot
              maxDepth: 'provider-managed'
```

The engine packages are still installed in the profile (both are linked to
their working trees); only the router holds the factory slot.

## Compatibility

The plugin implements the DSH **0.2 agent API**, developed and tested against
**DSH 0.2.2-rc.3**; the published peer range accepts every `0.2.2-rc.x` of
that line.

| DSH API | What the plugin does |
| --- | --- |
| `ctx.agents.setFactory` | registers the Vibe factory synchronously, so a session created right after the plugin mounts finds it |
| `Agent.inbox` | the driver owns the pending input (`src/inbox.ts`); DSH 0.2 turned `Inbox` into a structural interface, the implementation belongs to the driver |
| `Agent.model` | the driver owns the durable model choice (`src/model.ts`) |
| `CreateAgentOptions.meta` | the session's own `cwd` and fork lineage (`parentSession`) travel as session metadata |
| `ctx.agents.enter(agent)` | the agent joins the registry with the agent alone — the parent link is session data |
| `agent/created` | the registry announces the agent with the session source (`startup` / `resume`) |
| `agent/assistant-stream` | the start/chunk/end frames of one assistant attempt |
| `assistant/message` | carries the provider stream inside the event (`stream`), plus the token usage Vibe reports |
| `tool/call` / `tool/result` | Vibe's tool calls, as ACP reports them |
| session persistence | `persistence.create()` / `persistence.open(id, 'write')` own the stored log; the events reach the backend through its `session/event` subscription |

## Requirements

- Node.js ≥ 20
- [Mistral Vibe](https://console.mistral.ai/) installed and signed in — the
  `vibe-acp` executable must be on `PATH` (the Mistral installer puts it
  there). On Windows it is a `.cmd`/`.exe` shim; the plugin resolves it and
  launches it through `cmd.exe` with every argument quoted.
- [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) ≥ `0.2.2-rc.3`
  (`npm i -g @deepseek-ai/dsh`) with a profile exposing the `sessions`,
  `agents` and `sessionProjections` services (the standard frontend assembly)
- Peer deps: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`,
  `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-scope`, `@deepseek-ai/dsh-session`,
  `@deepseek-ai/dsh-session-persistence`, `@deepseek-ai/dsh-session-projection`

## Install

The package is not on the npm registry, so install it straight from the source
tree. The profile's plugin manager forwards to pnpm, so a local checkout is
installed like any other dependency:

```bash
# Link the working tree: the profile always runs your checkout (rebuild, then
# restart DSH). This is the development setup.
dsh plugin --profile desktop add link:/path/to/dsh-vibe-loop

# Or install a copy of the directory (what `npm pack` would produce).
dsh plugin --profile desktop add file:/path/to/dsh-vibe-loop
```

Both write the dependency into the profile's `package.json`; DSH then resolves
the plugin's `@deepseek-ai/*` imports against its own installation, so exactly
one DSH version is loaded in the process.

## Usage

Mount in the profile patch layer (`cordis.patch.yml`). A new plugin is mounted
with an `insert:` list — a bare `- id:` entry only overrides an entry that
already exists:

```yaml
# DSH's own loop holds the agent-factory slot and only one factory may be
# registered, so the native entry steps aside while Vibe is mounted.
- id: agent-loop
  disabled: true

# Use the Vibe loop for all new sessions.
- insert:
    - id: vibe-loop
      name: 'dsh-vibe-loop'
      config:
        vibePath: 'vibe-acp'            # or an absolute path
        cwd: '/path/to/your/project'    # working directory for Vibe sessions
        model: 'mistral-large-4-0-3'    # the Vibe model id
        pinModel: true                  # keep Vibe's route even if DSH asks for another
        permission: 'allow-once'        # how Vibe's tool permission requests are answered
        debug: false

# Fall back to DSH's own loop: disable this entry and re-enable agent-loop.
# - id: vibe-loop
#   disabled: true
```

### Config

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `vibePath` | `string` | `'vibe-acp'` | `vibe-acp` executable; resolved from `PATH` |
| `vibeArgs` | `string[]` | `[]` | Extra arguments passed to the executable |
| `cwd` | `string` | `process.cwd()` | Working directory for Vibe sessions (a session's own `cwd` wins) |
| `model` | `string` | — | Vibe model id (for example `mistral-large-4`) |
| `pinModel` | `boolean` | `true` | Always use `model`, ignoring the route the session asks for. The Vibe agent has a model of its own: the session's own model selection is the session's record and never reaches the child |
| `permission` | `'dsh' \| 'allow-once' \| 'deny'` | `'dsh'` | How Vibe's tool permission requests are answered: through DSH's own approval chain, once per call, or refused. A standing grant is never given |
| `mode` | `'ask' \| 'accept-edits' \| 'smart-approve' \| 'auto-approve'` | `'ask'` | The Vibe session mode. `ask` is what lets the approval chain decide; Vibe's own default (`accept-edits`) would approve file edits behind DSH's back |
| `debug` | `boolean` | `false` | Append protocol diagnostics to `<tmpdir>/dsh-vibe-loop.log` |

### Mounting rules

Two rules decide whether the plugin comes up:

1. **A new plugin is an `insert:` list.** A bare `- id: vibe-loop` entry only
   overrides an entry that already exists — the loader answers
   `patch: entry "vibe-loop" not found` and mounts nothing.
2. **Only one agent factory may hold the slot.** DSH's own `dsh-agent-loop`
   registers the factory first, so `agent-loop` has to be disabled while this
   plugin is mounted. Leaving both enabled fails with
   `an agent factory is already registered`.

## Session lifecycle

| Phase | What happens |
| --- | --- |
| create | the session is prepared, the persistence backend takes the write ownership of the stored log, a Vibe session is created (`session/new`), the model and the mode are applied, and the ACP session id is written to the sidecar |
| turn | DSH input is claimed from the inbox, the prompt goes to Vibe (`session/prompt`), Vibe's updates become DSH session events, and the backend stores them through its `session/event` subscription. A tool Vibe asks about goes through the DSH approval chain first |
| resume | the stored log is read back, an interrupted turn is closed durably, the Vibe session is reloaded (`session/load`) — or, when it is gone, the conversation is handed over as a transcript — and the next prompt continues that conversation |
| dispose | the child is stopped, the scope unwinds, and the persistence handle is closed |

## Platform notes

- **Windows**: `vibe-acp` is installed as a command shim. The plugin resolves
  the shim (`.exe`/`.com`/`.cmd`/`.bat`) and launches a `.cmd`/`.bat` through
  `cmd.exe` with every argument quoted. Point `vibePath` at the shim if it is
  not on `PATH`.
- **POSIX**: the executable is spawned directly.
- The diagnostics file lives in the platform temp directory (`os.tmpdir()`), so
  it is writable on every platform.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `patch: entry "vibe-loop" not found` | the entry is a bare `- id:` override instead of an `insert:` | wrap it in `- insert:` |
| `an agent factory is already registered` | DSH's `agent-loop` still holds the factory slot | disable `agent-loop` in the same patch layer |
| `no agent factory registered (load an agent-loop plugin)` | the plugin did not mount (wrong entry name, or the profile has no `agent-loop` and no `vibe-loop`) | check the entry `name:` and the loader's diagnostics |
| `vibe-acp process failed to start` | the executable is not on `PATH` | point `vibePath` at the absolute path |
| `vibe session does not offer the model "…"` | the model id is not one the session offers | check the ids Vibe lists for the `model` option |
| The resumed turn has no context | the Vibe session was gone and a fresh one was started | check the diagnostics for `session] loaded` vs `session] new`; the transcript is handed over with the first prompt |
| Every tool is refused | the approval chain has no answerer (the profile has no approval UI) and the session policy is `ask` | set `permission: 'allow-once'`, or compose an approval answerer in the profile |
| No diagnostics | `debug` is off | set `debug: true` and read `%TEMP%/dsh-vibe-loop.log` |

## Debugging

Set `debug: true`: every RPC command, every ACP update, the child-process
exit and the factory lifecycle steps are appended to
`<tmpdir>/dsh-vibe-loop.log` (`%TEMP%` on Windows, `/tmp` elsewhere). Vibe's
own stderr is forwarded into the same log. With `debug` off no sink is
installed at all — the protocol layer formats no diagnostics and touches no
disk.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # builds, then runs the node:test suite
npm run build       # refresh dist/ — what the profile actually loads
```

`package.json` pins the `@deepseek-ai/dsh-*` packages to `0.2.2-rc.3` through
an `overrides` block: the DSH packages pin each other's peers to an exact
version, so a mixed tree cannot be resolved — every one of them has to move
together.

`dist/` is what DSH loads, so a linked working tree needs `npm run build`
(and a DSH restart) to pick up a change.

The test runner needs Node ≥ 21 (its glob support); the library itself runs
on Node ≥ 20.11.

The suite covers the ACP client against a fake `vibe-acp` (a Node script that
speaks the real protocol), the event translation (reasoning, answer, tool
calls, usage, cancellation), the approval routing, the history replay and the
image blocks.

`tools/probe-router.mjs` mounts the router from a profile and creates one
session per preset, printing the driver each one got; `tools/probe-subagent.mjs`
runs one real task through the subagent provider.

`tools/dsh-e2e.mjs` drives the whole lifecycle against the real DSH packages:
it mounts the plugin on a bare context (sessions, agents, projections, the
JSONL persistence backend), creates a session, sends a prompt, disposes it,
resumes it from the stored log and sends a second prompt. It drives the fake
agent by default, so it burns no Mistral plan:

```bash
node tools/dsh-e2e.mjs          # hermetic: the fake vibe-acp
node tools/dsh-e2e.mjs --real   # the installed vibe-acp (uses the plan)
```

## License

Dual-licensed, at your option: **MIT** or **Apache-2.0**
(`MIT OR Apache-2.0`). Both are complete and free on their own terms.

Apache-2.0 is the better fit for corporate redistribution: besides the broad
copyright license, it grants a patent license (section 3) that terminates if
you initiate patent litigation against the copyright holder. MIT is the more
permissive of the two — shorter, no express patent grant, no NOTICE file.

Support, warranties and indemnification are not granted by either license.
They are a separate agreement with the copyright holder, not a third license
option.

Full texts: [`LICENSE`](LICENSE), [`LICENSE-MIT`](LICENSE-MIT),
[`LICENSE-APACHE`](LICENSE-APACHE).
