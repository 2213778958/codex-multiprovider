# codex-multiprovider (unofficial patch)

[![patch applies](https://github.com/2213778958/codex-multiprovider/actions/workflows/patch-applies.yml/badge.svg)](https://github.com/2213778958/codex-multiprovider/actions/workflows/patch-applies.yml)

Per-session model provider selection for Codex: pick an OpenAI model or a model from a second
provider (for example DeepSeek) in the existing model picker, and keep each session pinned to the
provider it started with. The desktop UI is not modified.

What is in this repository:

```
patch/model-provider-routes.patch   engine change only (codex-rs, 10 files)
tools/                              integration tooling, usable as-is:
                                      start-desktop-deepseek.ps1/.cmd   launcher
                                      deepseek-proxy.mjs                compatibility shim
                                      proxy-watchdog.mjs                session watchdog
                                      set-provider-key.ps1              store the key once (DPAPI)
                                      get-provider-key.ps1              engine-side token source
                                      merge-model-catalogs.mjs          build the merged catalog
                                      make-shortcut.ps1, stop-proxy.ps1 desktop / cleanup helpers
                                      routing-e2e.mjs, deepseek-live-probe.mjs,
                                      subagent-slot-probe.mjs           probes
config/                             example config snippet + minimal catalog template
```

> Unofficial. Not affiliated with, endorsed by, or supported by OpenAI. Not currently accepted
> upstream: `openai/codex` policy in `docs/contributing.md` is "We do not accept external code
> contributions or pull requests", so treat this as a local patch rather than a pending PR.
## Install

```powershell
git clone https://github.com/openai/codex.git
cd codex
git checkout 1715e55076        # the commit this patch was generated against
git apply path\to\patch\model-provider-routes.patch
cd codex-rs
cargo build -p codex-cli --bin codex
```

Then keep this repository next to the checkout you build (or anywhere) and follow the sections
below: store the provider key once (Windows DPAPI), build the merged catalog, merge the config
snippet, and start the client with `tools\start-desktop-deepseek.cmd`. The launcher finds the engine
automatically when it sits next to this repository; otherwise pass `-CodexExe <path to codex.exe>`.

Verification used while developing the patch:

* `cargo nextest run -p codex-app-server model_provider_routing` — 7 cases, all passing.
* Two subagent cases in `codex-rs/core/src/tools/handlers/multi_agents_tests.rs` — passing.
* `tools/routing-e2e.mjs` against a real engine: a routed model lands on its provider, an unrouted
  model keeps the default, and a contradictory explicit provider is rejected.
* `tools/deepseek-live-probe.mjs --no-env-key` against a real engine and a DPAPI-stored key: the
  provider's own `401` shows the masked tail of the stored key, which proves the request reached the
  provider with the token obtained through `auth.command`.
* UI level: with the patched engine, the unmodified Store client's picker lists the second
  provider's models next to the OpenAI ones, and a session created from that picker records the
  second provider in its rollout metadata.
* `tools/subagent-slot-probe.mjs` reproduces the nested-subagent budget behavior described under
  "Subagent limits worth knowing".

## What the engine change adds

| Area | Behavior |
| --- | --- |
| Config | `model_provider_routes`: `"<model slug>" = "<provider id>"` |
| `thread/start` | A routed model starts the session on its provider; a contradictory explicit provider is rejected |
| `thread/resume` | A session keeps the provider it was created with |
| `thread/settings/update` | Switching to another provider's model is rejected |
| Subagent spawn | A subagent model from another provider is rejected (children inherit the parent provider) |
| Config load | A route naming an unknown provider fails configuration loading |

The desktop UI needs no changes: it renders whatever `model/list` returns and sends the selected
model to `thread/start`. Because `model_catalog_json` replaces the account catalog, the catalog
file has to contain both providers' models; `tools/merge-model-catalogs.mjs` builds it.

## Setup

### 1. Build the engine

```powershell
cd codex-rs
cargo build -p codex-cli --bin codex
```

### 2. Store the provider key once

```powershell
powershell -ExecutionPolicy Bypass -File tools\set-provider-key.ps1
```

The key is encrypted with Windows DPAPI for the current user and stored at
`%USERPROFILE%\.codex\deepseek-key.dpapi`. The engine reads it back through the provider's
`auth.command` (see the config snippet), so it is never kept in the registry, in a plaintext file,
or in a permanent environment variable. Copy `get-provider-key.ps1` next to the config that
references it, or adjust the path in the snippet.

### 3. Build the merged catalog

```powershell
node tools\merge-model-catalogs.mjs "$env:USERPROFILE\.codex" `
  "$env:USERPROFILE\.codex\merged-models.json" `
  "C:\path\to\your-provider-models.json"
```

Start from `config/example-models.json` if you need to author the second provider's catalog.
Notes learned the hard way:

* Every entry needs instruction text — either `base_instructions` or
  `model_messages.instructions_template`. Write your own; do not paste another vendor's prompt.
* Required fields include `display_name`, `supported_reasoning_levels`, `shell_type`,
  `visibility`, `supported_in_api`, `priority`, `support_verbosity`, `default_verbosity`,
  `truncation_policy`, `experimental_supported_tools`.
* `visibility = "list"` is what makes a model appear in the picker.
* Save as **UTF-8 without BOM**. Windows PowerShell 5.1's `Set-Content -Encoding utf8` writes a
  BOM and the engine then fails with `expected value at line 1 column 1`. The Node merge script is
  safe.

### 4. Add the config

Merge `config/example.config-snippet.toml` into `%USERPROFILE%\.codex\config.toml`
(top-level `model_catalog_json`, the provider table, its `auth` sub-table, and the routes table).
`auth` cannot be combined with `env_key`, `experimental_bearer_token`, or `requires_openai_auth`.

Set the provider's `base_url` to the local compatibility proxy (step 5b):

```toml
[model_providers.deepseek]
base_url = "http://127.0.0.1:8899"
```

### 5a. Why a local proxy is needed

OpenAI's Responses API accepts `agent_message` input items. The engine delivers every inter-agent
message — including the first task given to a spawned subagent — **only** through such an item, and
the payload sits in its second content part:

```json
{"type":"agent_message","author":"/root","recipient":"/root/probe","content":[
  {"type":"input_text","text":"Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:\n"},
  {"type":"encrypted_content","encrypted_content":"<the actual task text>"}
]}
```

A provider that ignores unknown item types therefore drops the task: the subagent starts with only
developer and environment context, reports nothing to do, and completes immediately. Verified with a
controlled comparison against the provider (same text as a plain `message` is understood; as an
`agent_message` it is not), and end to end: with the rewrite below, a subagent spawned with
`fork_turns: "none"` (no inherited history) still received and executed its task.

`tools/deepseek-proxy.mjs` forwards requests to the real provider and rewrites `agent_message`
items into plain user messages (reading the `encrypted_content` part). Everything else — tools,
reasoning items, function calls, headers, streaming — is passed through untouched.

Robustness properties:

* A parse or rewrite failure forwards the original bytes, so the proxy can never make a request
  worse than running without it (the only regression would be subagent tasks again).
* Logging is best effort and never fails a request. Request bodies are **not** written unless
  `--body-dir` is passed, because they contain conversation content.
* `GET /__proxy/health` answers a marker, so the launcher can distinguish this proxy from an
  unrelated program on the same port, and `stop-proxy.ps1` only kills a process that answers it.
* Request timeouts are disabled for long streaming turns, and uncaught errors are logged instead of
  killing the process mid-conversation.

Failure modes to know: if the proxy is not running the provider is unreachable (a visible
connection error, not silent corruption) — the launcher starts it and refuses to launch the client
if it cannot; if the proxy dies mid-session the engine surfaces upstream errors and retries.

#### What can actually take the proxy down

| Situation | What you see | Recovery |
| --- | --- | --- |
| Reboot or sign-out | proxy gone (client is gone too) | launch again; the launcher starts it |
| Proxy killed by Task Manager, an endpoint agent, or OOM | DeepSeek turns fail with a connection error for a few seconds (visible, retried) | the session watchdog restarts it on the same port within one interval; without a watchdog, run the launcher again (`-ProxyOnly` works even while the client is open) |
| Another program holds the port | the launcher restarts the proxy on the port the config uses; if that port is held by something that is not this proxy, and no client is running, it moves to the next free port and rewrites the provider's `base_url` (config backed up) | none needed when no client is running; close the client first if one is |
| Node.js missing or not on `PATH` | the launcher throws `node was not found on PATH` and does not start the client | install Node.js, or use `-SkipProxy` |
| Upstream network/TLS failure | proxy answers `502` with an explicit message; the engine retries | transient; identical to running without the proxy |
| A payload shape the rewrite does not recognize | the request is forwarded **untouched** | nothing to do; the conversation still works |
| An `agent_message` whose payload is unreadable (e.g. really encrypted) | that item is left untouched and logged as `unreadableAgentMessages`; the proxy never injects ciphertext or JSON as if it were the task | subagent task may be missing, but nothing is corrupted |
| Disk full or log file locked | logging is skipped silently | free space; requests are unaffected |
| A second copy is started | the second exits with `EADDRINUSE`; the first keeps serving | none needed |
| Windows Firewall prompt on first run | none: the proxy binds `127.0.0.1` only, so no inbound rule is needed | dismiss safely if it appears |

The one invariant behind all of this: **a failing rewrite falls back to the original request**, so
the worst case for a normal conversation is "exactly as if the proxy were not there".

#### Ports

The provider's `base_url` has to be a literal: the engine does not expand environment variables in
config values, so the proxy address cannot be injected per session without an engine change. The
launcher therefore manages the address for you:

1. The port the config already uses wins, so an existing setup keeps working.
2. If nothing answers there, the launcher restarts the proxy **on that same port first** — the right
   move after a crash, because threads that are already running keep the `base_url` they started
   with, and moving the port would leave them pointing at nothing.
3. Only when that port is genuinely held by something else (the health marker does not match) and no
   client is running does it pick the next free port and rewrite `[model_providers.<id>].base_url`,
   keeping a timestamped backup of `config.toml`.

Use `-ProxyPort` to change the preferred port, and `-ProxyOnly` to make the proxy healthy again —
including after a port move — without starting a client.

#### Session watchdog

`tools/proxy-watchdog.mjs` watches the proxy while a client session is alive: every 10 seconds it
checks the health marker and, when the proxy is gone, restarts it **on the same port** (running
sessions keep the `base_url` they started with, so moving the port would strand them).

It is deliberately session-scoped:

* No autostart, no scheduled task, no registry entry, no permanent environment variable.
* It exits by itself ~20 seconds after the client is gone, and takes down the proxy it started, so a
  finished session leaves nothing behind (a proxy started by the launcher is left alone).
* It publishes `%USERPROFILE%\.codex\proxy-watchdog-<port>.json` so the launcher can tell whether one
  is already running and `stop-proxy.ps1` can find it. The launcher never starts a second one.
* Repeated restart failures (5 in a row, e.g. the port was taken by another program) make it give up
  and log why instead of spinning.

Start it through the launcher (default), or read `%USERPROFILE%\.codex\proxy-watchdog.log` to see
what it did. `-NoWatchdog` skips it. `stop-proxy.ps1` always stops the watchdog **before** the
proxy — otherwise the watchdog would immediately restart the proxy.

### 5b. Start the client

```powershell
powershell -ExecutionPolicy Bypass -File tools\start-desktop-deepseek.ps1
```

or double-click `tools\start-desktop-deepseek.cmd`. It stores the key once if no key file exists
yet, starts the compatibility proxy if it is not already healthy (`-SkipProxy` opts out), warns when
the provider's `base_url` does not point at the proxy, then sets the engine override for that
session only and starts the client.

Useful switches: `-ValidateOnly` (report engine, key, proxy, and provider URL without starting
anything), `-SkipProxy`, `-Detach`, `-ProxyPort`.

Stop the proxy with `tools\stop-proxy.ps1`. Revert by removing the `base_url` override (restores the
stock provider URL; subagent tasks stop arriving again).

#### Desktop shortcut

```powershell
powershell -ExecutionPolicy Bypass -File tools\make-shortcut.ps1
```

Creates `ChatGPT (DeepSeek engine).lnk` on the desktop, using `-Detach` (the launcher returns
immediately; the client keeps the environment it inherited) and the icon from the **installed**
package (`app\resources\chatgpt-app-dark.ico`). No OpenAI asset is copied into this repository or
next to the shortcut, and the shortcut description states that it is unofficial. Re-run the script
after a client update if the icon turns blank: Store package paths embed the package version.

On branding: the icon remains OpenAI's trademark asset. Referencing it from your own installed copy
to label a shortcut that starts that same app is ordinary descriptive use on your own machine, but
redistributing the icon file, or naming your own product "ChatGPT"/"Codex", is not covered by
Apache-2.0 (section 6 grants no trademark rights) and can imply endorsement. Ship the script, not
the asset, and keep the name clearly unofficial.

## Verifying a build

```powershell
# routing, provider pinning, and rejection of a contradictory provider
node tools\routing-e2e.mjs "<path to codex.exe>" "<CODEX_HOME with the config>"

# does the second provider expose the Responses path? (uses an invalid key unless one is set;
# pass --no-env-key to exercise the provider's auth.command instead)
node tools\deepseek-live-probe.mjs "<path to codex.exe>" "<CODEX_HOME>" --no-env-key
```

Tests for the engine change live in the usual suites:
`cargo nextest run -p codex-app-server model_provider_routing` (7 cases) and the two subagent
cases in `codex-rs/core/src/tools/handlers/multi_agents_tests.rs`.

## Subagent limits worth knowing (engine behavior, not this patch)

Nested subagents are bounded by an engine concurrency budget, and hitting it looks like "the agent
is stuck" rather than like an error. The numbers below come from the engine source:

* **Default budget: 4 concurrent agents per session.** The root session counts, so you get at most
  3 spawned subagents unless you raise it. `features.multi_agent_v2.max_concurrent_threads_per_session`
  is the primary key; `[agents] max_concurrent_threads_per_session` (alias `max_threads`) is honored
  too.
* **Running or waiting agents are never evicted.** Only an agent that is `Completed`, `Errored`, or
  `Interrupted`, with no active turn and no pending mailbox items, can be unloaded to free a slot
  (`core/src/agent/control/residency.rs`). So when every slot is held by an agent that is still
  working or waiting, a new spawn fails with `AgentLimitReached` — the model sees
  `agent thread limit reached`.
* **`wait_agent` defaults to a 30 second timeout** (`timeout_ms`, minimum 10s, maximum 1 hour).
  A parent waiting on nested children can therefore time out and report "nothing came back" while
  the children are still running. Passing a larger `timeout_ms` (up to 3600000) avoids those false
  "stuck" reports, but it does not create slots.
* **V2 has no nesting depth limit.** `agents.max_depth` only applies to the older V1 backend and is
  ignored by V2, so a deep tree is limited purely by the budget above.

Budget arithmetic for a tree of one root plus subagents:

| Shape | Agents needed | Fits in the default 4? |
| --- | --- | --- |
| 1 root + 3 children | 4 | yes |
| 1 root + 2 branches + 1 leaf each | 5 | no (one leaf starves) |
| 1 root + 2 branches + 2 leaves each | 7 | no (two leaves starve) |

If a workflow needs deeper fan-out, raise the budget yourself — it is a supported config key, not a
patch requirement:

```toml
[agents]
max_concurrent_threads_per_session = 8   # extra concurrent model conversations; more tokens and threads
```

Leaving it at the default is fine for depth-1 delegation; in that case tell the model not to nest,
and (optionally) ask it to pass a longer `timeout_ms` to `wait_agent`.

#### Reproduced: what "a branch is stuck" actually is

A request shaped like "spawn two subagents, have each spawn two more, then report back" (a 2x2 tree,
7 agents) was run twice against a real engine and provider:

| Budget | Result |
| --- | --- |
| default 4 | `agent thread limit reached` appears **inside a branch's own reasoning**, not as a tool error, so from outside it looks like one branch stalled while the other finished; one branch's leaves never start |
| 8 | no limit hit; both branches and all four leaves complete and return their results |

Two properties of the limit are worth knowing so it is not misread as a leak:

* It is starvation, not a leak. Waiting parents cannot be evicted, so with every slot held by a
  working or waiting agent the next spawn fails; once agents finish they are evicted (they drop out of
  `list_agents`, the threads stay on disk) and capacity returns — a follow-up turn could still spawn
  additional agents in the same session.
* `interrupt_agent` cannot reclaim a slot. Only closing an agent (`close_agent`, which shuts the
  thread down) or eviction of an agent in a final state frees one, so "I interrupted it and the slot
  never came back" is expected behavior rather than a bug.

## Caveats

* **Undocumented client hooks.** `CODEX_CLI_PATH` and `CODEX_APP_SERVER_FORCE_CLI` are read by the
  closed-source Store client. They are not part of this repository, are unsupported, and can change
  with any client update. This integration never modifies client files, does not bypass code
  signing or package integrity, and keeps the installed client usable as a fallback. Whether using
  an alternate engine with that client is acceptable under its terms of use is your call.
* **Wire protocol.** This build only accepts `wire_api = "responses"` for providers. Confirm your
  provider implements it, including tool calls and long contexts.
* **Model slugs** are configuration, not constants: use what the provider actually serves.
* Starting the client without the engine override leaves the picker showing the second provider's
  models while nothing routes them.

## Revert

Remove the `model_catalog_json`, `[model_providers.<id>]` (with its `auth`) and
`[model_provider_routes]` blocks from `config.toml`, then start the client normally.

## Not included

Client files (`app.asar`, `ChatGPT.exe`, DLLs), generated catalogs, and credentials of any kind.

## License

The patch applies to [openai/codex](https://github.com/openai/codex) (Apache-2.0). `LICENSE` and
`NOTICE` are retained; `NOTICE` records the modifications required by Apache-2.0 section 4(b).
