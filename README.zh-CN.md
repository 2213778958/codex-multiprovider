# codex-multiprovider（非官方补丁）

[![patch applies](https://github.com/2213778958/codex-multiprovider/actions/workflows/patch-applies.yml/badge.svg)](https://github.com/2213778958/codex-multiprovider/actions/workflows/patch-applies.yml)

[English](README.md) | **中文**

让 Codex **按会话选择模型供应商**：在**原有的模型选择器**里同时选 OpenAI 模型或第二家供应商
（例如 DeepSeek）的模型，并让每个会话固定在它启动时的供应商上。**不改动桌面 UI。**

> 英文版 [README.md](README.md) 为准；本文件是逐节对应的全文镜像，可能略滞后于英文版的更新。

仓库内容：

```
patch/model-provider-routes.patch   仅引擎改动（codex-rs，10 个文件）
tools/                              集成工具，可直接使用：
                                      start-desktop-deepseek.ps1/.cmd   启动器
                                      deepseek-proxy.mjs                兼容层（本机中转）
                                      proxy-watchdog.mjs                会话级看门狗
                                      set-provider-key.ps1              一次性存 key（DPAPI）
                                      get-provider-key.ps1              引擎侧取 token
                                      merge-model-catalogs.mjs          生成合并目录
                                      make-shortcut.ps1, stop-proxy.ps1 桌面快捷方式 / 清理
                                      routing-e2e.mjs, deepseek-live-probe.mjs,
                                      subagent-slot-probe.mjs           验证探针
config/                             示例配置片段 + 最小目录模板
```

> 非官方。与 OpenAI 无关联、未获其认可或支持，也不在其支持范围内。上游暂不接受此类改动：
> `openai/codex` 的 `docs/contributing.md` 明确写着 "We do not accept external code contributions
> or pull requests"，所以这里以**本地补丁**形式分发，而不是一个待合并的 PR。

## 安装

```powershell
git clone https://github.com/openai/codex.git
cd codex
git checkout 1715e55076        # 本补丁基于的提交
git apply path\to\patch\model-provider-routes.patch
cd codex-rs
cargo build -p codex-cli --bin codex
```

然后把本仓库放在你编译出的代码旁边（或任意位置），继续按下面的章节操作：一次性保存供应商 key
（Windows DPAPI）、生成合并目录、合并配置片段、用 `tools\start-desktop-deepseek.cmd` 启动客户端。
当本仓库与代码目录相邻时启动器会自动找到引擎，否则传 `-CodexExe <codex.exe 路径>`。

开发本补丁时用过的验证：

* `cargo nextest run -p codex-app-server model_provider_routing` —— 7 个用例全部通过。
* `codex-rs/core/src/tools/handlers/multi_agents_tests.rs` 里两个 subagent 用例 —— 通过。
* `tools/routing-e2e.mjs` 对真实引擎：有路由的模型落到它的供应商，未路由的保持默认，显式冲突的供应商被拒绝。
* `tools/deepseek-live-probe.mjs --no-env-key` 对真实引擎 + DPAPI 存的 key：供应商自己返回的 `401`
  里能看到所存 key 的掩码尾部，证明请求带着经 `auth.command` 取得的 token 到达了供应商。
* UI 层面：用打过补丁的引擎，**未改动的商店客户端**选择器里会同时列出第二家的模型，且由该选择器
  创建的会话会在 rollout 元数据里记录第二家供应商。
* `tools/subagent-slot-probe.mjs` 复现了"子代理限额"一节描述的嵌套行为。

## 引擎改动带来了什么

| 位置 | 行为 |
| --- | --- |
| 配置 | 新增 `model_provider_routes`：`"<模型 slug>" = "<供应商 id>"` |
| `thread/start` | 有路由的模型会让会话落在它的供应商上；显式给出相冲突的供应商会被拒绝 |
| `thread/resume` | 会话保持它创建时的供应商 |
| `thread/settings/update` | 中途切到别家供应商的模型会被拒绝 |
| 子代理 spawn | 子代理选到别家供应商的模型会被拒绝（子会话继承父供应商） |
| 配置加载 | 路由指向不存在的供应商会导致配置加载失败 |

桌面 UI 无需任何改动：它只是渲染 `model/list` 返回的内容，并把选中的模型发给 `thread/start`。
由于 `model_catalog_json` 会**整体替换**账户目录，目录文件必须同时包含两家供应商的模型；
`tools/merge-model-catalogs.mjs` 就是用来生成它的。

## 配置步骤

### 1. 编译引擎

```powershell
cd codex-rs
cargo build -p codex-cli --bin codex
```

### 2. 一次性保存供应商 key

```powershell
powershell -ExecutionPolicy Bypass -File tools\set-provider-key.ps1
```

key 用 Windows DPAPI 以当前用户身份加密，存放在 `%USERPROFILE%\.codex\deepseek-key.dpapi`。
引擎通过供应商配置里的 `auth.command` 把它取回来（见配置片段），因此它**不会**出现在注册表、
明文文件或永久环境变量里。请把 `get-provider-key.ps1` 放在配置里引用的位置，或修改片段中的路径。

### 3. 生成合并目录

```powershell
node tools\merge-model-catalogs.mjs "$env:USERPROFILE\.codex" `
  "$env:USERPROFILE\.codex\merged-models.json" `
  "C:\path\to\your-provider-models.json"
```

如果需要自己编写第二家的目录，可从 `config/example-models.json` 起步。以下是踩坑得来的注意事项：

* 每个条目都必须提供指令文本——`base_instructions` 或 `model_messages.instructions_template` 二者之一。
  **请自己写**，不要把别家的提示词正文抄进去。
* 必填字段包括：`display_name`、`supported_reasoning_levels`、`shell_type`、`visibility`、
  `supported_in_api`、`priority`、`support_verbosity`、`default_verbosity`、`truncation_policy`、
  `experimental_supported_tools`。
* `visibility = "list"` 才会让模型出现在选择器里。
* 存为 **UTF-8 且不带 BOM**。Windows PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写入 BOM，
  引擎随后报 `expected value at line 1 column 1`。Node 脚本（合并脚本）不受影响。

### 4. 加入配置

把 `config/example.config-snippet.toml` 合并进 `%USERPROFILE%\.codex\config.toml`
（顶层 `model_catalog_json`、供应商表、它的 `auth` 子表、以及路由表）。
`auth` 不能与 `env_key`、`experimental_bearer_token` 或 `requires_openai_auth` 同时使用。

把供应商的 `base_url` 指到本机兼容层（见 5b）：

```toml
[model_providers.deepseek]
base_url = "http://127.0.0.1:8899"
```

### 5a. 为什么需要本机中转

OpenAI 的 Responses API 接受 `agent_message` 类型的输入项。引擎把**所有**代理间消息——包括给新
子代理的第一个任务——**只**通过这种项投递，正文放在它的第二个内容段里：

```json
{"type":"agent_message","author":"/root","recipient":"/root/probe","content":[
  {"type":"input_text","text":"Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:\n"},
  {"type":"encrypted_content","encrypted_content":"<真正的任务正文>"}
]}
```

因此，忽略未知 item 类型的供应商会把任务丢掉：子代理只带着 developer 与环境上下文启动，报告
"没有可做的事"，随即完成。这一点用对照实验确认过（同一段文字放进普通 `message` 能被理解，放进
`agent_message` 则不能），也做了端到端确认：经下面的改写后，用 `fork_turns: "none"`（不继承任何历史）
启动的子代理依然收到了任务并执行。

`tools/deepseek-proxy.mjs` 把请求转发给真正的供应商，并把 `agent_message` 项改写成普通 user 消息
（正文取自 `encrypted_content` 段）。其余一切——tools、reasoning 项、function call、请求头、流式响应
——原样透传。

健壮性约束：

* 解析或改写失败时**原样转发原始字节**，所以有它在绝不会比没有它更糟（唯一退步是子代理任务又收不到）。
* 日志是尽力而为，绝不因写日志而让请求失败。请求体**默认不落盘**，除非显式传 `--body-dir`
  （因为其中含对话内容）。
* `GET /__proxy/health` 返回专属标记，启动器据此区分"我的中转"与"占用同一端口的别的程序"；
  `stop-proxy.ps1` 也只杀回应这个标记的进程。
* 长流式回合不会被超时切断；未捕获异常只记录日志，不会在对话中途把进程打死。

需要知道的失败形态：中转没在跑 → 供应商不可达（**可见的连接错误**，不会静默出错），启动器会先把它
拉起，拉不起来就**拒绝启动客户端**；中转在会话中途死掉 → 引擎暴露上游错误并重试。

#### 什么情况会让中转挂掉

| 情况 | 你会看到 | 恢复方式 |
| --- | --- | --- |
| 重启/注销 | 中转没了（客户端也没了） | 再启动一次，启动器会拉起它 |
| 被任务管理器/杀软/OOM 杀掉 | DeepSeek 回合连接错误数秒（可见、会重试） | 会话看门狗会在一个检查周期内在**同一端口**把它拉回；没有看门狗时再跑启动器（`-ProxyOnly` 在客户端开着时也能用） |
| 端口被别的程序占用 | 启动器先在配置用的端口上重启；若该端口被"非本中转"的程序占着且当前没有客户端在跑，它会换到下一个空闲端口并改写供应商 `base_url`（配置自动备份） | 没有客户端在跑时无需处理；有客户端时先关掉 |
| Node.js 缺失或不在 `PATH` | 启动器抛 `node was not found on PATH` 并且不启动客户端 | 安装 Node.js，或用 `-SkipProxy` |
| 上游网络/TLS 故障 | 中转回 `502` 并带明确信息；引擎重试 | 临时性问题；与没有中转时表现一致 |
| 遇到改写不认识的载荷形状 | 请求**原样**转发 | 无需处理，对话照常 |
| `agent_message` 的正文不可读（例如真被加密） | 该项保持原样，并记为 `unreadableAgentMessages`；中继**绝不**把密文或 JSON 当成任务塞进去 | 子代理任务可能仍缺失，但不会污染上下文 |
| 磁盘满或日志文件被锁 | 日志静默跳过 | 清空间即可；请求不受影响 |
| 误开第二个中转 | 第二个以 `EADDRINUSE` 退出，第一个继续服务 | 无需处理 |
| 首次运行的防火墙弹窗 | 不会有：只绑定 `127.0.0.1`，不需要任何入站规则 | 若出现可直接关闭 |

贯穿以上的一条不变量：**改写失败就退回原始请求**，所以对普通对话而言，最坏情况等于"从没有过这个中转"。

#### 端口

供应商的 `base_url` 必须是字面量：引擎不做配置值的环境变量展开，因此在不改引擎的前提下无法按会话
注入中转地址。于是由启动器替你管理地址：

1. 配置里已经在用的端口优先，已有的环境不受打扰。
2. 若那里没人应答，启动器**先在同一端口重启**中转——这是崩溃后最正确的做法，因为**已经在跑的会话
   会保留它们启动时的 `base_url`**，换端口等于让它们打向空气。
3. 只有该端口确实被别的程序占着（健康标记不匹配）、**且当前没有客户端在跑**时，才会挑下一个空闲端口，
   改写 `[model_providers.<id>].base_url`，并为 `config.toml` 留带时间戳的备份。

用 `-ProxyPort` 改首选端口；用 `-ProxyOnly` 在不启动客户端的情况下让中转恢复健康（换过端口后同样适用）。

#### 会话看门狗

`tools/proxy-watchdog.mjs` 在客户端会话存活期间盯着中转：每 10 秒检查一次健康标记，一旦中转消失就
**在同一端口**把它重启（运行中的会话保留启动时的 `base_url`，换端口会让它们失联）。

它刻意做成**会话级**：

* 不开机自启、不建计划任务、不写注册表、不设永久环境变量。
* 客户端退出约 20 秒后它自行退出，并收掉**它自己启动的**那个中转，所以会话结束不留任何东西
  （由启动器启动的中转它不动）。
* 它会写 `%USERPROFILE%\.codex\proxy-watchdog-<port>.json`，启动器据此判断是否已有一个在跑，
  `stop-proxy.ps1` 据此找到它。启动器绝不会启动第二个。
* 连续 5 次重启失败（例如端口被别的程序占用）就放弃并记录原因，而不是空转。

通过启动器启动它（默认），或看 `%USERPROFILE%\.codex\proxy-watchdog.log` 了解它做过什么。
`-NoWatchdog` 可跳过。`stop-proxy.ps1` **总是先停看门狗再停中转**——否则看门狗会立刻把中转又拉起来。

### 5b. 启动客户端

```powershell
powershell -ExecutionPolicy Bypass -File tools\start-desktop-deepseek.ps1
```

或双击 `tools\start-desktop-deepseek.cmd`。若还没有 key 文件，它会先让你保存一次 key；若中转不健康
就启动它（`-SkipProxy` 可跳过）；若供应商 `base_url` 没指向中转会给出告警；然后**只在本会话**设置引擎
覆盖并启动客户端。

常用开关：`-ValidateOnly`（只报告引擎、key、中转与供应商地址，不启动任何东西）、`-SkipProxy`、
`-Detach`、`-ProxyPort`。

停止中转用 `tools\stop-proxy.ps1`。回退方式是去掉 `base_url` 覆盖（恢复官方供应商地址；子代理任务
会重新收不到）。

#### 桌面快捷方式

```powershell
powershell -ExecutionPolicy Bypass -File tools\make-shortcut.ps1
```

会在桌面创建 `ChatGPT (DeepSeek engine).lnk`，使用 `-Detach`（启动器立即返回；客户端保留它继承到的
环境），图标取自**已安装**的包（`app\resources\chatgpt-app-dark.ico`）。**没有**任何 OpenAI 素材被复制
进本仓库或快捷方式旁边，快捷方式描述里也写明是非官方。客户端更新后若图标变空白，重跑一次脚本即可：
商店包路径里含包版本号。

关于品牌：该图标仍是 OpenAI 的商标素材。在你自己的机器上引用本机已安装副本里的图标、去标注"启动这个
应用"的快捷方式，属于描述性使用；但**再分发该图标文件**、或把你自己的产物命名为 "ChatGPT"/"Codex"，
都不在 Apache-2.0 的授权范围内（第 6 条不授予商标权），并且可能被理解为官方背书。发布**脚本**，而不是
**素材**，并让名字明确是非官方的。

## 验证一次构建

```powershell
# 路由、供应商固定、显式冲突被拒绝
node tools\routing-e2e.mjs "<codex.exe 路径>" "<含该配置的 CODEX_HOME>"

# 第二家供应商是否暴露 Responses 路径？（默认用无效 key；加 --no-env-key 则走供应商的 auth.command）
node tools\deepseek-live-probe.mjs "<codex.exe 路径>" "<CODEX_HOME>" --no-env-key
```

引擎改动的测试在常规测试套件里：
`cargo nextest run -p codex-app-server model_provider_routing`（7 个用例），以及
`codex-rs/core/src/tools/handlers/multi_agents_tests.rs` 里的两个 subagent 用例。

## 值得知道的子代理限额（引擎行为，与本补丁无关）

嵌套子代理受引擎的并发预算限制，而撞上限额的表现更像"代理卡住了"，不像报错。以下数字来自引擎源码：

* **默认预算：每会话 4 个并发代理。** 根会话也占一个，所以不调大的话你最多只能有 3 个子代理。
  主键是 `features.multi_agent_v2.max_concurrent_threads_per_session`；
  `[agents] max_concurrent_threads_per_session`（别名 `max_threads`）同样生效。
* **运行中或等待中的代理永远不会被淘汰。** 只有处于 `Completed`、`Errored`、`Interrupted`，且没有
  进行中的 turn、没有待处理邮箱消息的代理才能被卸载以腾出槽位
  （`core/src/agent/control/residency.rs`）。所以当每个槽位都被"仍在干活或仍在等待"的代理占住时，
  新的 spawn 会失败并返回 `AgentLimitReached` —— 模型看到的是 `agent thread limit reached`。
* **`wait_agent` 默认 30 秒超时**（`timeout_ms`，最小 10 秒、最大 1 小时）。因此等待嵌套子代理的父代理
  可能超时并报告"什么都没回来"，而子代理其实还在跑。传更大的 `timeout_ms`（最大 3600000）能消除这类
  误判，但**不会**变出槽位。
* **V2 没有嵌套深度上限。** `agents.max_depth` 只对旧的 V1 后端生效，V2 会忽略它，所以树的深度纯粹受
  上面的预算约束。

一棵"一个根 + 若干子代理"的树所需槽位：

| 形态 | 需要的代理数 | 默认 4 个够吗 |
| --- | --- | --- |
| 1 根 + 3 个子 | 4 | 够 |
| 1 根 + 2 分支 + 每支 1 个叶子 | 5 | 不够（一个叶子饿死） |
| 1 根 + 2 分支 + 每支 2 个叶子 | 7 | 不够（两个叶子饿死） |

如果某个工作流需要更宽的扇出，自行调大预算即可——这是受支持的配置项，不是补丁要求：

```toml
[agents]
max_concurrent_threads_per_session = 8   # 更多并发模型对话；token 与线程数都会上升
```

保持默认对"只委派一层"完全够用；这种用法下告诉模型不要嵌套，并且（可选）让它给 `wait_agent` 传更长的
`timeout_ms`。

#### 复现记录："某个分支卡住"到底是什么

"开两个 subagent，让每个再各开两个，然后汇报"这种请求（2×2 树，7 个代理）在真实引擎 + 真实供应商上
跑过两次：

| 预算 | 结果 |
| --- | --- |
| 默认 4 | `agent thread limit reached` 出现在**某个分支自己的 reasoning 里**，而不是作为工具错误返回，所以从外面看就像"一个分支卡住了、另一个完成了"；其中一个分支的叶子始终没启动 |
| 8 | 没有撞限额；两个分支与全部四个叶子都完成并返回了结果 |

限额有两个性质值得记住，以免被误读成泄漏：

* 它是**饥饿**，不是泄漏。等待中的父代理不可淘汰，所以当每个槽位都被干活或等待中的代理占住时，下一个
  spawn 就会失败；代理一旦完成就会被淘汰（从 `list_agents` 消失，线程仍在磁盘上），容量随之恢复——
  同一会话的后续回合依然能继续 spawn。
* **`interrupt_agent` 无法回收槽位。** 只有关闭代理（`close_agent`，它会关停线程）或让处于终态的代理
  被淘汰才能释放一个槽位。所以"我中断了它，槽位却没回来"是预期行为，而不是 bug。

## 已知边界

* **客户端未公开的钩子。** `CODEX_CLI_PATH` 与 `CODEX_APP_SERVER_FORCE_CLI` 是闭源商店客户端读取的
  变量。它们不属于本仓库、不受支持，且可能随任何一次客户端更新而改变或消失。本集成**从不修改客户端
  文件**，不绕过代码签名或包完整性校验，并始终保留"官方客户端可用"作为退路。用替代引擎配合该客户端
  是否符合其使用条款，需要你自己判断。
* **线协议。** 本构建对供应商只接受 `wire_api = "responses"`。请确认你的供应商实现了它，包括工具调用
  与长上下文。
* **模型 slug 是配置，不是常量**：写供应商实际提供的名字。
* 不带引擎覆盖启动客户端时，选择器仍会列出第二家的模型，但没有任何东西会把它们路由过去。

## 回退

从 `config.toml` 里删掉 `model_catalog_json`、`[model_providers.<id>]`（连同它的 `auth`）与
`[model_provider_routes]` 三段，然后正常启动客户端即可。

## 不包含什么

客户端文件（`app.asar`、`ChatGPT.exe`、各类 DLL）、生成的模型目录、以及任何形式的凭据。

## 许可

本补丁应用于 [openai/codex](https://github.com/openai/codex)（Apache-2.0）。`LICENSE` 与 `NOTICE`
均予保留；`NOTICE` 记录了 Apache-2.0 第 4(b) 条所要求的修改声明。
