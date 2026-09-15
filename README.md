# codex-multiprovider (unofficial patch)

[![patch applies](https://github.com/2213778958/codex-multiprovider/actions/workflows/patch-applies.yml/badge.svg)](https://github.com/2213778958/codex-multiprovider/actions/workflows/patch-applies.yml)

**English** | [中文说明](README.zh-CN.md)

> Unofficial; not affiliated with, endorsed by, or supported by OpenAI. Upstream does not accept
> external contributions (`openai/codex` `docs/contributing.md`: "We do not accept external code
> contributions or pull requests"), so this ships as a local patch, not a pull request.

Adds a second model provider (DeepSeek by default) to the Codex desktop model picker, and pins every
session to the provider it starts on. The desktop client is not modified.

| Picker choice | Provider of that session |
| --- | --- |
| OpenAI model, e.g. `gpt-5.5` | OpenAI |
| Second-provider model, e.g. `deepseek-flash` | the second provider |

* The provider is fixed at `thread/start`; `thread/resume` keeps it, `thread/settings/update` cannot switch it.
* Subagents inherit the parent's provider; a subagent model from another provider is rejected.
* A route naming an unconfigured provider fails config loading.

<!-- sync:begin -->

## Pieces

| Piece | Path | Purpose |
| --- | --- | --- |
| Engine patch | `patch/model-provider-routes.patch` (codex-rs, 18 files) | adds `model_provider_routes` and pins the engine version the desktop client expects |
| Merged catalog | `tools/merge-model-catalogs.mjs` | `model_catalog_json` replaces the account catalog, so one file must hold both providers' models |
| Local proxy | `tools/deepseek-proxy.mjs`, bound to `127.0.0.1` | rewrites `agent_message` items and `call_id`-less `function_call_output` items into user messages; without it every spawned subagent gets an empty task and a delegated thread is rejected |

The rest of `tools/` is the launcher, watchdog, key storage, and probes.

## Requirements

| Need | Note |
| --- | --- |
| Windows | DPAPI key storage; PowerShell and `.cmd` helpers |
| Node.js on `PATH` | proxy and tooling |
| `git` and Rust/Cargo | engine build; Rust from <https://rustup.rs> |
| Codex desktop app | used unmodified; stays usable without this project |
| ~10 GB disk and 10–30 minutes | first `cargo build`; later builds are incremental |

`install-engine.ps1` stops with an install hint when `git` or `cargo` is missing. rustup offers the
MSVC C++ build tools on Windows; accept, then reopen the shell.

## Setup

### 1. Build the engine

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-engine.ps1
```

Or double-click `tools\install-engine.cmd`. Clones upstream at the pinned commit, applies
`patch\model-provider-routes.patch`, and builds `codex.exe`. Refuses a dirty checkout or a commit
other than the pinned one.

Manual equivalent:

```powershell
git clone https://github.com/openai/codex.git
cd codex
git checkout 1715e55076737158ba61d43158ede504de6d4ce1   # commit the patch was generated against
git apply ..\patch\model-provider-routes.patch
cd codex-rs
cargo build -p codex-cli --bin codex
```

Engine discovery: the launcher checks `codex-rs\target\release\codex.exe`, then `debug\codex.exe`, in
the directory containing this repository and one level above it. Any other layout, including the
`codex-engine` directory the installer creates, needs `-CodexExe <path to codex.exe>`.

Slow crates.io — set these in your own shell; the project never touches global config:

```powershell
$env:CARGO_REGISTRIES_CRATES_IO_INDEX = "sparse+https://rsproxy.cn/index/"
$env:RUSTUP_DIST_SERVER = "https://rsproxy.cn"
$env:RUSTUP_UPDATE_ROOT = "https://rsproxy.cn/rustup"
git -c http.proxy=http://127.0.0.1:7890 clone https://github.com/openai/codex.git
```

The first build produces roughly 10 GB and takes 10–30 minutes.

### 2. Store the provider key

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-tools.ps1
powershell -ExecutionPolicy Bypass -File tools\set-provider-key.ps1
```

`install-tools.ps1` copies `set-provider-key.ps1` and `get-provider-key.ps1` into `~/.codex` and
reports outdated copies. They are installed, not referenced: the provider config pins the command
path and the engine snapshots provider config per session, so a path inside a checkout breaks running
sessions when that checkout moves, is deleted, or changes branch (`The argument
'...get-provider-key.ps1' to the -File parameter does not exist`).

The key is DPAPI-encrypted for the current user at `%USERPROFILE%\.codex\deepseek-key.dpapi` and read
back by the engine through `auth.command`. It never lives in the registry, a plaintext file, or a
persistent environment variable.

### 3. Build the merged catalog

```powershell
node tools\merge-model-catalogs.mjs "$env:USERPROFILE\.codex" `
  "$env:USERPROFILE\.codex\merged-models.json" `
  "C:\path\to\your-provider-models.json"
```

Merges your provider catalog into the account catalog cached at `<CODEX_HOME>\models_cache.json`. Start
from `config/example-models.json`; run Codex once if that cache does not exist yet.

Entry requirements:

* Instruction text: `base_instructions` or `model_messages.instructions_template`. Write your own.
* Required fields: `display_name`, `supported_reasoning_levels`, `shell_type`, `visibility`,
  `supported_in_api`, `priority`, `support_verbosity`, `default_verbosity`, `truncation_policy`,
  `experimental_supported_tools`.
* `visibility = "list"` to appear in the picker.
* UTF-8 without BOM. PowerShell 5.1's `Set-Content -Encoding utf8` writes a BOM, and the engine then
  fails with `expected value at line 1 column 1`. The Node script never writes one.

### 4. Config

Merge `config/example.config-snippet.toml` into `%USERPROFILE%\.codex\config.toml`:

```toml
model_catalog_json = "C:\\Users\\<you>\\.codex\\merged-models.json"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "http://127.0.0.1:8899"   # local proxy, step 5
wire_api = "responses"
requires_openai_auth = false

[model_providers.deepseek.auth]
command = "powershell"
args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\Users\\<you>\\.codex\\get-provider-key.ps1", "-Path", "C:\\Users\\<you>\\.codex\\deepseek-key.dpapi"]

[model_provider_routes]
"deepseek-flash" = "deepseek"
```

`auth` excludes `env_key`, `experimental_bearer_token`, and `requires_openai_auth`.

### 5. Start the client

```powershell
powershell -ExecutionPolicy Bypass -File tools\start-desktop-deepseek.ps1
```

Or double-click `tools\start-desktop-deepseek.cmd`. The launcher stores a key when no key file exists,
starts the proxy and its watchdog when the proxy is unhealthy, warns when `base_url` does not point at
the proxy, sets the engine override for that session only, and prefers `target\release\codex.exe` over
`target\debug\codex.exe`.

## Verify

Picker: the second provider's models appear next to the OpenAI ones. A session started on one of them
sends its requests to that provider — visible in `%USERPROFILE%\.codex\proxy-log.jsonl`.

```powershell
# routing, provider pinning, rejection of a contradictory provider
node tools\routing-e2e.mjs "<path to codex.exe>" "<CODEX_HOME with the config>"

# does the second provider expose the Responses path? (invalid key unless one is set;
# --no-env-key exercises the provider's auth.command instead)
node tools\deepseek-live-probe.mjs "<path to codex.exe>" "<CODEX_HOME>" --no-env-key
```

Engine test suites: `cargo nextest run -p codex-app-server model_provider_routing` (8 cases), the two
subagent cases in `codex-rs/core/src/tools/handlers/multi_agents_tests.rs`, and
`cargo test -p codex-core --test all completed_child_wakes_idle_parent`.

## Operations

| Task | Command |
| --- | --- |
| Start the client | `tools\start-desktop-deepseek.cmd` |
| Check engine, key, proxy, provider URL without starting anything | `tools\start-desktop-deepseek.ps1 -ValidateOnly` |
| Revive the proxy while a client is open | `tools\start-desktop-deepseek.ps1 -ProxyOnly` |
| Skip the proxy | `tools\start-desktop-deepseek.ps1 -SkipProxy` |
| Skip the watchdog | `tools\start-desktop-deepseek.ps1 -NoWatchdog` |
| Change the proxy port | `tools\start-desktop-deepseek.ps1 -ProxyPort 8900` |
| Force an engine build | `tools\start-desktop-deepseek.ps1 -CodexExe <path to codex.exe>` |
| Stop proxy and watchdog | `tools\stop-proxy.ps1` |
| Create a desktop shortcut | `tools\make-shortcut.ps1` |

`make-shortcut.ps1` creates `ChatGPT (DeepSeek engine).lnk` using `-Detach` and the icon from the
installed package (`app\resources\chatgpt-app-dark.ico`). No OpenAI asset is copied into this
repository or next to the shortcut, and the description marks it unofficial. Re-run it when a client
update blanks the icon, because Store paths embed the package version. The icon stays OpenAI's
trademark: referencing it from your own installed copy is descriptive use; redistributing the file or
naming a product "ChatGPT"/"Codex" is not covered by Apache-2.0 §6.

## Updating

### Desktop client update (Microsoft Store)

| Symptom | Cause | Action |
| --- | --- | --- |
| Shortcut icon is blank | Store paths embed the package version | re-run `tools\make-shortcut.ps1` |
| Picker lists the models but nothing routes, or the client ignores your engine | `CODEX_CLI_PATH` / `CODEX_APP_SERVER_FORCE_CLI` changed (undocumented hooks) | check with `-ValidateOnly`; without them the official client still works, without the second provider |
| New OpenAI models are missing | the merged catalog is a snapshot | re-run `merge-model-catalogs.mjs` |
| Protocol errors against your engine | the client is ahead of the engine's commit | rebuild the engine from a newer commit (below) |

### Engine from a newer upstream commit

`install-engine.ps1` accepts the pinned commit only. To build a newer engine:

```powershell
cd .\codex-engine                        # the checkout install-engine.ps1 created
git fetch origin
git checkout <new commit or origin/main>
git apply -3 ..\patch\model-provider-routes.patch
cd codex-rs
cargo build -p codex-cli --bin codex --release
```

`-3` three-way merges instead of failing at the first mismatch; resolve remaining conflicts by hand —
the patch touches `codex-rs` only, 18 files. If Git reports a missing blob, run `git fetch
--unshallow` first. Verify with the commands under [Verify](#verify) before switching; the launcher
picks up `target\release\codex.exe`, or try the new binary once with `-CodexExe <path>`.

Maintainers re-pin instead of hand-patching: rebase onto the newer upstream, run
`tools\sync-to-public.ps1` (regenerates the patch, rewrites the pinned commit in both READMEs and in
the CI workflow), and update `$PinnedSha` in `tools\install-engine.ps1`. The README,
`.github/workflows/patch-applies.yml`, and that script must agree; CI fails when the README and the
workflow disagree.

### This repository

```powershell
git pull
powershell -ExecutionPolicy Bypass -File tools\install-tools.ps1   # refresh the ~/.codex key scripts
powershell -ExecutionPolicy Bypass -File tools\make-shortcut.ps1   # only when the icon is blank
```

The launcher, proxy, and probes run from the checkout. If `patch\model-provider-routes.patch` changed,
rebuild the engine.

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| Second provider: connection errors | proxy not running, provider unreachable | wait for the watchdog, or `tools\start-desktop-deepseek.ps1 -ProxyOnly` |
| `node was not found on PATH` | Node.js missing | install Node.js, or use `-SkipProxy` |
| Port held by another program | the configured port is taken | with no client running, the launcher moves to the next free port and rewrites `base_url` (config backed up); close the client otherwise |
| `agent thread limit reached` inside a branch | subagent concurrency budget | raise `[agents] max_concurrent_threads_per_session`, or stop nesting |
| Subagent reports nothing to do | its task was an `agent_message` the provider ignored | ensure the proxy runs and `base_url` points at it |
| `expected value at line 1 column 1` | catalog has a UTF-8 BOM | re-save without a BOM |
| `...get-provider-key.ps1' to the -File parameter does not exist` | a running session points at a moved key script | re-run `tools\install-tools.ps1`, restart the session |
| OpenAI models missing from the picker | the merged catalog lacks them | re-run `merge-model-catalogs.mjs` against a populated `models_cache.json` |
| `Patched engine not found` | the build is outside the two `codex-rs\target` locations | `tools\start-desktop-deepseek.ps1 -CodexExe <path>` |
| `The '<model>' model is not supported when using Codex with a ChatGPT account` | the session started on the default provider while running a routed model; builds before the default-model routing landed did this for threads created without a model, such as `create_thread` delegations | rebuild the engine from a checkout that includes the fix, then recreate the thread |
| `Forking is not available for threads using paginated history yet`, or new threads flip between `legacy` and `paginated` | the Store client gates paginated forks on the app-server version (`>= 0.146.0-alpha.7`, `>= 0.146.0-alpha.8` for ephemeral forks) and a source build reports `0.0.0` | build from this patch (it pins `0.146.0-alpha.8` in `codex-rs/Cargo.toml`) or raise that version; then restart the client |
| `Failed to collect working tree diff` when branching a thread into a new worktree | the client carries the uncommitted diff by staging it in the source repository, which a write-protected repository (ACL deny on the tree or `.git`) refuses | unlock the repository for the duration, start the worktree from a branch/commit instead of the working tree, or branch in the same directory |

Logs: `%USERPROFILE%\.codex\proxy-log.jsonl` (request bodies only with `--body-dir`),
`%USERPROFILE%\.codex\proxy-watchdog.log`, `%USERPROFILE%\.codex\proxy-watchdog-<port>.json`.

## Reference: patch behavior

| Area | Behavior |
| --- | --- |
| Config | `model_provider_routes`: `"<model slug>" = "<provider id>"` |
| `thread/start` | a routed model starts on its provider; a contradictory explicit provider is rejected; a request that names no model is routed by the config's default `model` |
| `thread/resume` | keeps the provider the session was created with |
| `thread/settings/update` | switching to another provider's model is rejected |
| Subagent spawn | a foreign-provider model is rejected (children inherit the parent provider) |
| Config load | a route naming an unknown provider fails loading |
| Engine version | `codex-rs/Cargo.toml` reports `0.146.0-alpha.8`; the desktop client gates features on the app-server version and treats a `0.0.0` source build as ancient |

## Reference: proxy

The engine sends every inter-agent message, including the first task of a spawned subagent, only as an
`agent_message` item, with the payload in the second content part:

```json
{"type":"agent_message","author":"/root","recipient":"/root/probe","content":[
  {"type":"input_text","text":"Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:\n"},
  {"type":"encrypted_content","encrypted_content":"<the actual task text>"}
]}
```

A provider that ignores unknown item types drops the task: the subagent starts with developer and
environment context only, reports nothing to do, and completes. Verified by comparison against the
provider (the same text as a plain `message` is understood, as `agent_message` it is not) and end to
end (with the rewrite, a subagent spawned with `fork_turns: "none"` still received and executed its
task).

`deepseek-proxy.mjs` rewrites those items into plain user messages using the `encrypted_content` part.
Tool calls, reasoning items, headers, and streaming pass through unchanged.

The same proxy repairs the other item a delegated thread is built from. The desktop client starts an
agent-created thread with the `create_thread` result injected as a `function_call_output` that has no
`call_id`:

```json
{"type":"function_call_output","name":"create_thread","namespace":"codex_app","output":"<codex_delegation>…</codex_delegation>"}
```

A tool result cannot be matched to a function call without that id, and providers differ on whether
they tolerate it: the ones that do not reject the whole request with `missing field call_id`. The
proxy rewrites the item into the plain user message it really is, so the delegated task reaches the
provider. The rewrites live in `proxy-transforms.mjs` (plain ESM, imported by the proxy):

```powershell
node --test tools\proxy-transforms.test.mjs
```

* Parse or rewrite failure forwards the original bytes; never worse than running without the proxy,
  except that subagent tasks go missing again.
* Logging is best effort and never fails a request; bodies are written only with `--body-dir`.
* `GET /__proxy/health` returns a marker: the launcher uses it to identify the proxy, and
  `stop-proxy.ps1` kills only a process that answers it.
* Request timeouts are disabled for long streaming turns; uncaught errors are logged, not fatal.
* An unreadable `agent_message` payload is left untouched and counted in `unreadableAgentMessages`;
  ciphertext is never injected as a task.
* A `function_call_output` that cannot be read verbatim is left untouched and counted in
  `unreadableItems`; the repaired count is logged as `repairedCallOutputs`.

Ports: `base_url` must be a literal, since the engine does not expand environment variables in config
values. The launcher:

1. keeps the port already in the config;
2. if nothing answers there, restarts the proxy **on that port** — running threads keep the `base_url`
   they started with;
3. only when that port is held by a non-proxy process and no client is running, moves to the next free
   port and rewrites `[model_providers.<id>].base_url`, keeping a timestamped backup of `config.toml`.

`-ProxyPort` changes the preferred port; `-ProxyOnly` repairs the proxy without starting a client.

Watchdog: every 10 s it checks the health marker and restarts the proxy on the same port while a
session is alive. No autostart, scheduled task, registry entry, or persistent environment variable. It
exits about 20 s after the client and stops the proxy it started (one started by the launcher is left
alone). State lives in `%USERPROFILE%\.codex\proxy-watchdog-<port>.json`; it gives up after 5
consecutive restart failures. `-NoWatchdog` disables it. `stop-proxy.ps1` always stops the watchdog
before the proxy.

## Reference: engine behavior (not this patch)

### Thread history modes

* `legacy`: one append-only rollout file per thread (`%USERPROFILE%\.codex\sessions\<date>\rollout-*.jsonl`); a resume reads the whole file.
* `paginated`: the same rollout is projected into `%USERPROFILE%\.codex\thread_history_1.sqlite` (`thread_turns`, `thread_items`) and the client reads it page by page (`thread/turns/list`, `thread/items/list`). Display metadata moves to SQLite, because a paginated rollout may only carry a suffix.
* Promotion is one-way: the `background_paginated_rollout_migration` feature migrates legacy threads in the background, and stale legacy metadata never downgrades them.
* The client picks the mode from the app-server version (see Troubleshooting): with a `0.0.0` engine it flip-flops between the two, and branching a paginated thread needs a version it recognises.

### Subagent limits

* Default budget: 4 concurrent agents per session. The root counts, so 3 spawned subagents. Primary key
  `features.multi_agent_v2.max_concurrent_threads_per_session`; `[agents]
  max_concurrent_threads_per_session` (alias `max_threads`) also works.
* Running or waiting agents are never evicted. Only `Completed`, `Errored`, or `Interrupted` agents
  with no active turn and no pending mailbox items can be unloaded
  (`core/src/agent/control/residency.rs`). With every slot held, a spawn fails with
  `AgentLimitReached` — the model sees `agent thread limit reached`.
* `wait_agent` times out after 30 s by default (`timeout_ms`, 10 s–1 h). A parent waiting on nested
  children can report "nothing came back" while they still run; a larger `timeout_ms` (up to 3600000)
  avoids that false report but adds no slots.
* V2 has no depth limit; `agents.max_depth` applies to the V1 backend only.

| Tree | Agents | Fits in the default 4? |
| --- | --- | --- |
| 1 root + 3 children | 4 | yes |
| 1 root + 2 branches + 1 leaf each | 5 | no, one leaf starves |
| 1 root + 2 branches + 2 leaves each | 7 | no, two leaves starve |

```toml
[agents]
max_concurrent_threads_per_session = 8   # more concurrent model conversations, more tokens
```

Reproduction: "spawn two subagents, each spawns two more" (2×2 tree, 7 agents) on a real engine and
provider.

| Budget | Result |
| --- | --- |
| 4 (default) | `agent thread limit reached` appears inside a branch's own reasoning, not as a tool error, so it looks like one branch stalled while the other finished; one branch's leaves never start |
| 8 | no limit hit; both branches and all four leaves complete |

Starvation, not a leak: waiting parents cannot be evicted, so spawns fail while slots are held;
finished agents are evicted (they leave `list_agents`, threads stay on disk) and capacity returns.
`interrupt_agent` frees no slot — only `close_agent` or eviction of a final-state agent does.

### Parent wake on completion

* Parent blocked in `wait_agent`: mailbox activity ends the wait and the same turn continues. Config
  does not affect this path.
* Parent turn already finished: the envelope is queued until your next message, unless
  `wake_parent_on_completion` is set. This build defaults to `true`, so a finished child starts a new
  parent turn.

```toml
[agents]
wake_parent_on_completion = true   # true (default here): a finished child resumes an idle parent
                                   # false: upstream behavior, waits for your next message
```

Only finished children wake an idle parent; mail arriving during a turn is drained into that turn, so
several children finishing together produce one follow-up turn.

## Caveats

* `CODEX_CLI_PATH` and `CODEX_APP_SERVER_FORCE_CLI` are read by the closed-source Store client. They
  are unsupported, are not part of this repository, and can change with any client update. This
  integration never modifies client files, never bypasses code signing or package integrity, and keeps
  the official client usable as a fallback. Whether an alternate engine is acceptable under the
  client's terms of use is your call.
* `wire_api = "responses"` is the only accepted provider API in this build; the provider must
  implement it, including tool calls and long contexts.
* Model slugs are configuration, not constants: use what the provider serves.
* Starting the client without the engine override leaves the second provider's models in the picker
  while nothing routes them.

## Revert

Remove `model_catalog_json`, `[model_providers.<id>]` (with its `auth`), and `[model_provider_routes]`
from `config.toml`, then start the client normally. Removing only the `base_url` override restores the
stock provider URL, and subagent tasks stop arriving.

## Contents

```
patch/model-provider-routes.patch   engine change only (codex-rs, 18 files)
tools/                              integration tooling, usable as-is:
                                      install-engine.ps1/.cmd           clone + patch + build the engine
                                      start-desktop-deepseek.ps1/.cmd   launcher
                                      deepseek-proxy.mjs                compatibility shim
                                      proxy-watchdog.mjs                session watchdog
                                      set-provider-key.ps1              store the key once (DPAPI)
                                      get-provider-key.ps1              engine-side token source
                                      install-tools.ps1                 install the two scripts into ~/.codex
                                      merge-model-catalogs.mjs          build the merged catalog
                                      make-shortcut.ps1, stop-proxy.ps1 desktop / cleanup helpers
                                      routing-e2e.mjs, deepseek-live-probe.mjs,
                                      subagent-slot-probe.mjs           probes
                                      sync-to-public.ps1                rebuild the patch + this README (maintainers)
config/                             example config snippet + minimal catalog template
```

Development verification:

* `cargo nextest run -p codex-app-server model_provider_routing` — 8 cases pass.
* Two subagent cases in `codex-rs/core/src/tools/handlers/multi_agents_tests.rs` pass.
* `routing-e2e.mjs` against a real engine: a routed model lands on its provider, an unrouted model
  keeps the default, a request that names no model is routed by the config default, and a
  contradictory explicit provider is rejected.
* `deepseek-live-probe.mjs --no-env-key` against a real engine and a DPAPI-stored key: the provider's
  own `401` shows the masked tail of the stored key, proving the token from `auth.command` reached it.
* UI: the unmodified Store client's picker lists both providers' models, and a session created from it
  records the second provider in its rollout metadata.
* `codex --version` (and the app-server handshake the client reads) reports `0.146.0-alpha.8` instead
  of `0.0.0`, so the client stops gating features like forking paginated threads.
* `subagent-slot-probe.mjs` reproduces the budget behavior above.
* `completed_child_wakes_idle_parent` covers both sides of the wake switch.

<!-- sync:end -->

## Not included

Client files (`app.asar`, `ChatGPT.exe`, DLLs), generated catalogs, credentials.

## License

The patch applies to [openai/codex](https://github.com/openai/codex) (Apache-2.0). `LICENSE` and
`NOTICE` are retained; `NOTICE` records the modifications required by Apache-2.0 section 4(b).
