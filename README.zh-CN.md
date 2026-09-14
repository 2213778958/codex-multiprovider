# codex-multiprovider（非官方补丁）

[![patch applies](https://github.com/2213778958/codex-multiprovider/actions/workflows/patch-applies.yml/badge.svg)](https://github.com/2213778958/codex-multiprovider/actions/workflows/patch-applies.yml)

[English](README.md) | **中文**

> 非官方；与 OpenAI 无关联、未获其认可或支持。上游不接受外部贡献（`openai/codex` 的
> `docs/contributing.md`："We do not accept external code contributions or pull requests"），
> 因此这里以本地补丁形式分发，而非一个待合并的 PR。本文件是 [README.md](README.md) 的中文镜像。

让 Codex 桌面端的选择器也能列出第二家供应商（默认 DeepSeek）的模型，并让每个会话固定在它启动时的
供应商上。桌面客户端不做任何修改。

| 选择器里选 | 该会话的供应商 |
| --- | --- |
| OpenAI 模型，如 `gpt-5.5` | OpenAI |
| 第二家模型，如 `deepseek-flash` | 第二家供应商 |

* 供应商在 `thread/start` 时定下；`thread/resume` 保持不变，`thread/settings/update` 无法切换。
* 子代理继承父代理的供应商；子代理选到别家的模型会被拒绝。
* 路由指向未配置的供应商会导致配置加载失败。

## 三块拼图

| 部分 | 路径 | 作用 |
| --- | --- | --- |
| 引擎补丁 | `patch/model-provider-routes.patch`（codex-rs，10 个文件） | 新增 `model_provider_routes` |
| 合并目录 | `tools/merge-model-catalogs.mjs` | `model_catalog_json` 会整体替换账户目录，因此一个文件必须同时含两家的模型 |
| 本机中转 | `tools/deepseek-proxy.mjs`，只绑定 `127.0.0.1` | 把 `agent_message` 项改写成 user 消息；没有它，每个 spawn 出来的子代理都会拿到空任务 |

`tools/` 其余部分是启动器、看门狗、key 存储与验证探针。

## 环境要求

| 需要 | 说明 |
| --- | --- |
| Windows | key 用 DPAPI 存储；辅助脚本是 PowerShell 与 `.cmd` |
| `PATH` 上有 Node.js | 中转与工具链 |
| `git` 与 Rust/Cargo | 编译引擎；Rust 从 <https://rustup.rs> 安装 |
| Codex 桌面客户端 | 不做修改；不用本项目时它照常可用 |
| 约 10 GB 空间、10~30 分钟 | 首次 `cargo build`；之后为增量编译 |

`install-engine.ps1` 在缺少 `git` 或 `cargo` 时直接停下并给出安装提示。Windows 上 rustup 会提供
MSVC C++ 生成工具，接受后重开终端。

## 安装

### 1. 编译引擎

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-engine.ps1
```

也可双击 `tools\install-engine.cmd`。脚本按钉住的提交克隆上游、应用
`patch\model-provider-routes.patch`、编译 `codex.exe`；checkout 不干净或提交不符时拒绝执行。

手动等价操作：

```powershell
git clone https://github.com/openai/codex.git
cd codex
git checkout 1715e55076737158ba61d43158ede504de6d4ce1   # 补丁针对的提交
git apply ..\patch\model-provider-routes.patch
cd codex-rs
cargo build -p codex-cli --bin codex
```

引擎查找：启动器会在「本仓库所在目录」和「其上一级目录」下依次找
`codex-rs\target\release\codex.exe` 与 `debug\codex.exe`。其他摆放方式（包括安装脚本创建的
`codex-engine` 目录）需传 `-CodexExe <codex.exe 路径>`。

crates.io 慢时，只在自己的终端设置（本项目不写全局配置）：

```powershell
$env:CARGO_REGISTRIES_CRATES_IO_INDEX = "sparse+https://rsproxy.cn/index/"
$env:RUSTUP_DIST_SERVER = "https://rsproxy.cn"
$env:RUSTUP_UPDATE_ROOT = "https://rsproxy.cn/rustup"
git -c http.proxy=http://127.0.0.1:7890 clone https://github.com/openai/codex.git
```

首次编译产出约 10 GB，耗时 10~30 分钟。

### 2. 存储供应商 key

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-tools.ps1
powershell -ExecutionPolicy Bypass -File tools\set-provider-key.ps1
```

`install-tools.ps1` 把 `set-provider-key.ps1` 与 `get-provider-key.ps1` 复制进 `~/.codex`，并在副本
过期时提示。之所以是"安装"而非引用：供应商配置钉死了命令路径，而引擎按会话快照供应商配置，所以
checkout 内的路径在该 checkout 被移动、删除或切换分支后会让运行中的会话全部失效（报错：`The
argument '...get-provider-key.ps1' to the -File parameter does not exist`）。

key 以当前用户身份经 DPAPI 加密存放在 `%USERPROFILE%\.codex\deepseek-key.dpapi`，引擎通过
`auth.command` 读取。它不会出现在注册表、明文文件或永久环境变量中。

### 3. 生成合并目录

```powershell
node tools\merge-model-catalogs.mjs "$env:USERPROFILE\.codex" `
  "$env:USERPROFILE\.codex\merged-models.json" `
  "C:\path\to\your-provider-models.json"
```

把供应商目录合并进 `<CODEX_HOME>\models_cache.json` 里的账户目录缓存。第二家的目录可从
`config/example-models.json` 起步；若缓存不存在，先启动一次 Codex 生成。

条目要求：

* 指令文本：`base_instructions` 或 `model_messages.instructions_template`，内容自己写。
* 必填字段：`display_name`、`supported_reasoning_levels`、`shell_type`、`visibility`、
  `supported_in_api`、`priority`、`support_verbosity`、`default_verbosity`、`truncation_policy`、
  `experimental_supported_tools`。
* `visibility = "list"` 才会出现在选择器里。
* UTF-8 且不带 BOM。PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM，引擎随后报
  `expected value at line 1 column 1`；Node 脚本不会写 BOM。

### 4. 配置

把 `config/example.config-snippet.toml` 合并进 `%USERPROFILE%\.codex\config.toml`：

```toml
model_catalog_json = "C:\\Users\\<you>\\.codex\\merged-models.json"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "http://127.0.0.1:8899"   # 本机中转，见第 5 步
wire_api = "responses"
requires_openai_auth = false

[model_providers.deepseek.auth]
command = "powershell"
args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\Users\\<you>\\.codex\\get-provider-key.ps1", "-Path", "C:\\Users\\<you>\\.codex\\deepseek-key.dpapi"]

[model_provider_routes]
"deepseek-flash" = "deepseek"
```

`auth` 不能与 `env_key`、`experimental_bearer_token`、`requires_openai_auth` 并用。

### 5. 启动客户端

```powershell
powershell -ExecutionPolicy Bypass -File tools\start-desktop-deepseek.ps1
```

也可双击 `tools\start-desktop-deepseek.cmd`。启动器会：无 key 文件时先存 key；中转不健康时拉起中转与
看门狗；`base_url` 未指向中转时告警；仅为本次会话设置引擎覆盖；优先使用 `target\release\codex.exe`
而非 `target\debug\codex.exe`。

## 验证

选择器：第二家的模型与 OpenAI 的并列显示。用它新建会话后，请求会发往那家供应商，可在
`%USERPROFILE%\.codex\proxy-log.jsonl` 看到。

```powershell
# 路由、供应商固定、显式冲突被拒绝
node tools\routing-e2e.mjs "<codex.exe 路径>" "<含该配置的 CODEX_HOME>"

# 第二家是否暴露 Responses 路径？（默认用无效 key；--no-env-key 则走 auth.command）
node tools\deepseek-live-probe.mjs "<codex.exe 路径>" "<CODEX_HOME>" --no-env-key
```

引擎测试：`cargo nextest run -p codex-app-server model_provider_routing`（7 个用例）、
`codex-rs/core/src/tools/handlers/multi_agents_tests.rs` 的两个 subagent 用例、以及
`cargo test -p codex-core --test all completed_child_wakes_idle_parent`。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 启动客户端 | `tools\start-desktop-deepseek.cmd` |
| 只检查引擎、key、中转、供应商地址 | `tools\start-desktop-deepseek.ps1 -ValidateOnly` |
| 客户端开着时救活中转 | `tools\start-desktop-deepseek.ps1 -ProxyOnly` |
| 跳过中转 | `tools\start-desktop-deepseek.ps1 -SkipProxy` |
| 跳过看门狗 | `tools\start-desktop-deepseek.ps1 -NoWatchdog` |
| 换中转端口 | `tools\start-desktop-deepseek.ps1 -ProxyPort 8900` |
| 指定引擎构建 | `tools\start-desktop-deepseek.ps1 -CodexExe <codex.exe 路径>` |
| 停止中转与看门狗 | `tools\stop-proxy.ps1` |
| 创建桌面快捷方式 | `tools\make-shortcut.ps1` |

`make-shortcut.ps1` 用 `-Detach` 与已安装包里的图标（`app\resources\chatgpt-app-dark.ico`）创建
`ChatGPT (DeepSeek engine).lnk`。没有任何 OpenAI 素材被复制进本仓库或快捷方式旁边，描述里标明非官方。
客户端更新后图标变空白时重跑一次即可（商店包路径含版本号）。图标仍是 OpenAI 的商标：从自己已安装的
副本引用属描述性使用；再分发该文件或把自己的产物命名为 "ChatGPT"/"Codex" 不在 Apache-2.0 §6 授权内。

## 更新

### 桌面客户端更新（微软商店）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 快捷方式图标变空白 | 商店路径含包版本号 | 重跑 `tools\make-shortcut.ps1` |
| 选择器有模型但不路由，或客户端不用你的引擎 | `CODEX_CLI_PATH` / `CODEX_APP_SERVER_FORCE_CLI` 变了（未公开钩子） | 用 `-ValidateOnly` 检查；没有钩子时官方客户端仍可用，只是没有第二家供应商 |
| 新的 OpenAI 模型不见了 | 合并目录是快照 | 重跑 `merge-model-catalogs.mjs` |
| 与你的引擎通信报协议错误 | 客户端跑在引擎所基于的提交前面 | 用更新的提交重新编译引擎（见下） |

### 引擎跟进上游新提交

`install-engine.ps1` 只接受钉住的提交。编译更新的引擎：

```powershell
cd .\codex-engine                        # install-engine.ps1 创建的 checkout
git fetch origin
git checkout <新提交或 origin/main>
git apply -3 ..\patch\model-provider-routes.patch
cd codex-rs
cargo build -p codex-cli --bin codex --release
```

`-3` 做三方合并，而不是在第一个不匹配处失败；剩余冲突手动解决即可（补丁只碰 `codex-rs`，10 个文件）。
若 Git 报缺 blob，先跑 `git fetch --unshallow`。切换前按[验证](#验证)一节的命令确认；启动器会自动采用
`target\release\codex.exe`，也可先用 `-CodexExe <路径>` 试跑。

维护者应重新钉版本而不是手动打补丁：把改动 rebase 到更新的上游之上，运行 `tools\sync-to-public.ps1`
（重新生成补丁，并改写两份 README 与 CI workflow 里的钉住提交），再更新 `tools\install-engine.ps1`
里的 `$PinnedSha`。README、`.github/workflows/patch-applies.yml` 与该脚本三处必须一致，CI 会在 README
与 workflow 不一致时失败。

### 本仓库更新

```powershell
git pull
powershell -ExecutionPolicy Bypass -File tools\install-tools.ps1   # 刷新 ~/.codex 里的取 key 脚本
powershell -ExecutionPolicy Bypass -File tools\make-shortcut.ps1   # 仅在图标变空白时需要
```

启动器、中转与探针直接从 checkout 运行。若 `patch\model-provider-routes.patch` 有变化，重新编译引擎。

## 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 第二家供应商：连接错误 | 中转未运行，供应商不可达 | 等看门狗恢复，或 `tools\start-desktop-deepseek.ps1 -ProxyOnly` |
| `node was not found on PATH` | 缺 Node.js | 安装 Node.js，或用 `-SkipProxy` |
| 端口被别的程序占用 | 配置的端口被占 | 无客户端运行时启动器会换到下一个空闲端口并改写 `base_url`（配置有备份）；否则先关客户端 |
| 分支里出现 `agent thread limit reached` | 子代理并发预算 | 调大 `[agents] max_concurrent_threads_per_session`，或不要嵌套 |
| 子代理报告无事可做 | 任务作为 `agent_message` 被供应商忽略 | 确认中转在跑且 `base_url` 指向它 |
| `expected value at line 1 column 1` | 目录文件带 UTF-8 BOM | 重存为不带 BOM |
| `...get-provider-key.ps1' to the -File parameter does not exist` | 运行中的会话指向已移动的取 key 脚本 | 重跑 `tools\install-tools.ps1`，重启会话 |
| 选择器里缺 OpenAI 模型 | 合并目录里没有它们 | 用有内容的 `models_cache.json` 重跑 `merge-model-catalogs.mjs` |
| `Patched engine not found` | 构建不在启动器搜索的两个 `codex-rs\target` 位置 | `tools\start-desktop-deepseek.ps1 -CodexExe <路径>` |

日志：`%USERPROFILE%\.codex\proxy-log.jsonl`（仅传 `--body-dir` 时记录请求体）、
`%USERPROFILE%\.codex\proxy-watchdog.log`、`%USERPROFILE%\.codex\proxy-watchdog-<port>.json`。

## 参考：补丁行为

| 位置 | 行为 |
| --- | --- |
| 配置 | `model_provider_routes`：`"<模型 slug>" = "<供应商 id>"` |
| `thread/start` | 有路由的模型落在其供应商上；显式给出相冲突的供应商被拒绝 |
| `thread/resume` | 保持会话创建时的供应商 |
| `thread/settings/update` | 切到别家供应商的模型被拒绝 |
| 子代理 spawn | 别家供应商的模型被拒绝（子代理继承父代理供应商） |
| 配置加载 | 路由指向未知供应商会导致加载失败 |

## 参考：本机中转

引擎把每一条代理间消息（包括给新子代理的第一个任务）**只**作为 `agent_message` 项投递，正文在第二个
内容段：

```json
{"type":"agent_message","author":"/root","recipient":"/root/probe","content":[
  {"type":"input_text","text":"Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:\n"},
  {"type":"encrypted_content","encrypted_content":"<真正的任务正文>"}
]}
```

忽略未知 item 类型的供应商会丢掉该任务：子代理只带 developer 与环境上下文启动，报告无事可做后立即完成。
已通过对照实验确认（同一段文字作为普通 `message` 能被理解，作为 `agent_message` 不能），也做了端到端确认
（经改写后，用 `fork_turns: "none"` 启动的子代理仍收到并执行了任务）。

`deepseek-proxy.mjs` 从 `encrypted_content` 段取出正文，把这些项改写成普通 user 消息；tools、
reasoning 项、function call、请求头与流式响应原样透传。

* 解析或改写失败时转发原始字节；最坏情况等同于没有中转，只是子代理任务又会丢失。
* 日志尽力而为，绝不因写日志让请求失败；只有传 `--body-dir` 才落盘请求体。
* `GET /__proxy/health` 返回标记：启动器据此识别中转，`stop-proxy.ps1` 只杀回应标记的进程。
* 长流式回合不设超时；未捕获异常只记日志，不会中断进程。
* `agent_message` 正文不可读时该项保持原样，并计入 `unreadableAgentMessages`；绝不把密文当作任务注入。

端口：`base_url` 必须是字面量（引擎不展开配置值里的环境变量）。启动器：

1. 优先使用配置里已有的端口；
2. 若无人应答，在**同一端口**重启中转——运行中的线程保留启动时的 `base_url`；
3. 仅当该端口被非中转进程占用且无客户端运行时，换到下一个空闲端口并改写
   `[model_providers.<id>].base_url`，同时保留带时间戳的 `config.toml` 备份。

`-ProxyPort` 改首选端口；`-ProxyOnly` 只修复中转、不启动客户端。

看门狗：会话存活期间每 10 秒检查一次健康标记，中转消失时在同一端口重启它。不开机自启、不建计划任务、
不写注册表、不设永久环境变量；客户端退出约 20 秒后自行退出，并收掉它自己启动的中转（启动器启动的不动）。
状态写在 `%USERPROFILE%\.codex\proxy-watchdog-<port>.json`；连续 5 次重启失败后放弃。`-NoWatchdog` 关闭它。
`stop-proxy.ps1` 总是先停看门狗再停中转。

## 参考：引擎行为（与本补丁无关）

### 子代理限额

* 默认预算：每会话 4 个并发代理。根会话占一个，即最多 3 个子代理。主键
  `features.multi_agent_v2.max_concurrent_threads_per_session`；`[agents]
  max_concurrent_threads_per_session`（别名 `max_threads`）同样有效。
* 运行中或等待中的代理永不被淘汰。只有 `Completed`、`Errored`、`Interrupted` 且无进行中 turn、无待处理
  邮箱消息的代理可被卸载（`core/src/agent/control/residency.rs`）。槽位全被占满时 spawn 失败并返回
  `AgentLimitReached`，模型看到的是 `agent thread limit reached`。
* `wait_agent` 默认 30 秒超时（`timeout_ms`，10 秒~1 小时）。等待嵌套子代理的父代理可能报"什么都没回来"
  而子代理仍在运行；传更大的 `timeout_ms`（最大 3600000）可消除这种误报，但不增加槽位。
* V2 无嵌套深度上限；`agents.max_depth` 只对 V1 后端生效。

| 形态 | 代理数 | 默认 4 个够吗 |
| --- | --- | --- |
| 1 根 + 3 个子 | 4 | 够 |
| 1 根 + 2 分支 + 每支 1 叶子 | 5 | 不够，一个叶子饿死 |
| 1 根 + 2 分支 + 每支 2 叶子 | 7 | 不够，两个叶子饿死 |

```toml
[agents]
max_concurrent_threads_per_session = 8   # 更多并发模型对话，token 消耗更多
```

复现："开两个 subagent，各再开两个"（2×2 树，7 个代理），真实引擎 + 真实供应商。

| 预算 | 结果 |
| --- | --- |
| 4（默认） | `agent thread limit reached` 出现在某分支自己的 reasoning 里，而非工具错误，外观上像一个分支卡住、另一个完成；该分支的叶子始终不启动 |
| 8 | 未撞限额；两个分支与四个叶子全部完成 |

是饥饿而非泄漏：等待中的父代理不可淘汰，槽位占满时 spawn 失败；代理完成后被淘汰（从 `list_agents`
消失，线程仍在磁盘上），容量恢复。`interrupt_agent` 不释放槽位，只有 `close_agent` 或终态代理被淘汰才会。

### 子代理完成后唤醒父代理

* 父代理阻塞在 `wait_agent`：邮箱活动结束等待，同一 turn 继续。该路径不受配置影响。
* 父代理那一轮已结束：信封排队到你的下一次输入，除非设置了 `wake_parent_on_completion`。本构建默认为
  `true`，即结束的子代理会拉起父代理的新一轮。

```toml
[agents]
wake_parent_on_completion = true   # true（本构建默认）：子代理结束即唤醒空闲父代理
                                   # false：上游行为，等你的下一句话
```

只有已结束的子代理才唤醒空闲父代理；turn 进行中到达的邮件会并入该 turn，所以多个子代理同时结束只产生
一次后续回合。

## 已知边界

* `CODEX_CLI_PATH` 与 `CODEX_APP_SERVER_FORCE_CLI` 由闭源商店客户端读取。它们不受支持、不属于本仓库，
  且可能随客户端更新改变。本集成从不修改客户端文件，不绕过代码签名或包完整性校验，并保留官方客户端可用
  作为退路。用替代引擎是否符合其使用条款需自行判断。
* 本构建对供应商只接受 `wire_api = "responses"`；供应商必须实现它，包括工具调用与长上下文。
* 模型 slug 是配置而非常量：写供应商实际提供的名字。
* 不带引擎覆盖启动客户端时，选择器仍会列出第二家的模型，但没有任何东西路由它们。

## 回退

从 `config.toml` 删除 `model_catalog_json`、`[model_providers.<id>]`（连同 `auth`）与
`[model_provider_routes]`，然后正常启动客户端。只删 `base_url` 覆盖则恢复官方供应商地址，子代理任务
重新收不到。

## 仓库内容

```
patch/model-provider-routes.patch   仅引擎改动（codex-rs，10 个文件）
tools/                              集成工具，可直接使用：
                                      install-engine.ps1/.cmd           克隆 + 打补丁 + 编译引擎
                                      start-desktop-deepseek.ps1/.cmd   启动器
                                      deepseek-proxy.mjs                兼容层（本机中转）
                                      proxy-watchdog.mjs                会话级看门狗
                                      set-provider-key.ps1              一次性存 key（DPAPI）
                                      get-provider-key.ps1              引擎侧取 token
                                      install-tools.ps1                 把上面两个脚本装到 ~/.codex
                                      merge-model-catalogs.mjs          生成合并目录
                                      make-shortcut.ps1, stop-proxy.ps1 桌面快捷方式 / 清理
                                      routing-e2e.mjs, deepseek-live-probe.mjs,
                                      subagent-slot-probe.mjs           验证探针
                                      sync-to-public.ps1                重建补丁与本 README（维护者用）
config/                             示例配置片段 + 最小目录模板
```

开发期验证：

* `cargo nextest run -p codex-app-server model_provider_routing` —— 7 个用例通过。
* `codex-rs/core/src/tools/handlers/multi_agents_tests.rs` 的两个 subagent 用例通过。
* `routing-e2e.mjs` 对真实引擎：有路由的模型落到其供应商，未路由的保持默认，显式冲突被拒绝。
* `deepseek-live-probe.mjs --no-env-key` 对真实引擎 + DPAPI 存的 key：供应商返回的 `401` 里能看到所存
  key 的掩码尾部，证明经 `auth.command` 取得的 token 到达了供应商。
* UI：未改动的商店客户端选择器同时列出两家模型，且由其创建的会话在 rollout 元数据里记录第二家供应商。
* `subagent-slot-probe.mjs` 复现上述预算行为。
* `completed_child_wakes_idle_parent` 覆盖唤醒开关的两侧。

## 不包含

客户端文件（`app.asar`、`ChatGPT.exe`、各类 DLL）、生成的目录、任何凭据。

## 许可

本补丁应用于 [openai/codex](https://github.com/openai/codex)（Apache-2.0）。保留 `LICENSE` 与
`NOTICE`；`NOTICE` 记录了 Apache-2.0 第 4(b) 条要求的修改声明。
