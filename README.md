# magpie-better-claude-support

[English](README.en.md) | 简体中文

[![npm](https://img.shields.io/npm/v/magpie-better-claude-support?color=cb3837&logo=npm)](https://www.npmjs.com/package/magpie-better-claude-support)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![magpie](https://img.shields.io/badge/magpie-plugin-111827)](https://github.com/yetone/magpie)
[![node](https://img.shields.io/badge/node-%E2%89%A524-3c873a)](package.json)
[![stars](https://img.shields.io/github/stars/SpookySandwich/magpie-better-claude-support?style=flat&label=stars)](https://github.com/SpookySandwich/magpie-better-claude-support/stargazers)

在 [Magpie](https://github.com/yetone/magpie) 中运行**真正完整**的 Claude Code 引擎——保留全套原生工具与 `@ultracode` 多智能体编排，并在 5 小时订阅窗口触顶时自动无缝切换到 Anthropic Console API 余额，告别限流停工。

---

## 为什么需要这个插件

Magpie 内置的 Claude Code 集成在启动时传入了 `--tools ""`，将 Claude CLI 降级为不带原生工具的纯文本接口，且一旦 5 小时或周订阅额度用满（100%）便直接报错中断。

**`magpie-better-claude-support`**（Provider ID: `claude-native`）用单一入口解决了这些妥协：完整释放 Claude Code 的原生工具链与工作流编排，同时把「Pro/Max 订阅」与「Console API 余额」合二为一。

| 能力维度 | Magpie 内置 `claude` | `magpie-better-claude-support` (`claude-native`) |
| :--- | :--- | :--- |
| **Claude 原生工具与工作流** | 被禁用（`--tools ""`） | **完整保留原生工具链 + `@ultracode` 多智能体并行编排** |
| **5 小时 / 周额度用满时** | 直接报错中断（`429`） | **自动无缝切换到 Console API Key 余额，窗口重置后自动切回** |
| **用量面板** | 仅显示订阅百分比 | **单张卡片同时展示：5h/7d 订阅窗口 + API 实时剩余美金** |
| **模型与思考强度列表** | 二进制内硬编码 | **零计费动态探测本机 Claude CLI 实际支持的全部模型与档位** |
| **网关隐私脱敏兼容性** | 脱敏占位符会直接写入本地文件或命令 | **发往云端的提示词保持脱敏；本地执行工具前经密钥校验自动还原真实值** |
| **多轮响应速度** | `-p` 模式每轮重新冷启动进程 | **空闲进程热驻留复用，消除每轮冷启动开销** |
| **断线 / 网关重试安全** | 网关盲目重试可能导致文件被改两遍 | **原子会话租约锁拦截已产生副作用的轮次，杜绝重复执行** |

---

## 核心价值

### 1. 满血 Claude Code 原生运行时与 `@ultracode`
不再把 Claude CLI 当作阉割版聊天接口，而是完整启用 Claude Code 原生工具（`Read`、`Edit`、`Write`、`Bash`、`Workflow`）与原生系统提示词。所有支持 `xhigh` 推理的模型都会自动派生出 `@ultracode` 变体，支持多阶段子智能体（Subagent）并发协作，并在后台子任务全部收尾后才结束当前轮次。

### 2. 订阅 → API 额度零中断热切换
每一轮请求都 100% 优先消耗你的 Claude Pro / Max 订阅。只有当 5 小时或周窗口达到 100%，或首包遭遇 `402` / `429` 限流拒绝时，才会自动切换到备用 Anthropic Console API Key 继续执行，并在窗口恢复后自动切回订阅。

### 3. 一张卡片看清「订阅窗口 + API 剩余美金」
Anthropic 官方没有提供查询 Console 赠金/余额的接口，导致切到 API 后往往只能盲跑。本插件将 Anthropic Admin 已结算日账单（精确到美分）与当日小时级 Token 消耗实时拼接（实测误差约 0.2%），在同一个 Magpie 卡片上同时呈现订阅百分比、API 剩余美金与过期时间。

### 4. 新模型与思考强度零成本自动发现
Anthropic 发布新模型或开放 1M 上下文时无需等待插件更新。启动时通过初始化握手直接读取本机 Claude CLI 的模型选择器，不发送任何计费请求，即可自动挂载当前账号可用的全部模型与思考档位（`low` / `medium` / `high` / `xhigh` / `max`）。

### 5. 网关开启隐私脱敏时，本地工具依然拿到真实值
当 Magpie 开启隐私脱敏（Redaction）时，提示词中的密钥会被替换为占位符；普通模式下模型写文件或跑终端命令会把假占位符原样写进代码库。本插件在保证**发往 Anthropic 云端的 Prompt 全程脱敏**的前提下，利用本机脱敏密钥校验并在本地工具执行前的一刻将占位符安全还原为真实值。

### 6. 进程热驻留与防重放保护
一轮对话结束后，Claude 进程在后台保持热驻留以供下一轮复用，省去进程反复初始化的等待；同时通过会话租约锁严格区分「尚未执行被上游拒绝」与「本地工具已开始执行」，即便网络闪断触发客户端重试，也绝不会把修改文件的操作重复执行两遍。

### 7. 彻底的凭证与环境变量隔离
从 Claude Desktop 或带环境变量的终端启动 Magpie 时，残留的 `CLAUDE*` / `ANTHROPIC_*` 变量常常会导致 API Key 轮次偷偷扣减订阅额度（或反过来）。本插件在拉起子进程前彻底净化环境，并支持将 `sk-ant-usr…` 用户级密钥精确绑定到指定的 Console Workspace 计费。

---

## 快速开始

### 1. 安装插件

在终端运行以下命令（或直接在 Magpie 桌面端的 **扩展 / Plugins** 搜索框中输入 `github:SpookySandwich/magpie-better-claude-support` 点击安装）：

```bash
magpie plugin add github:SpookySandwich/magpie-better-claude-support
```

### 2. 登录账号

绑定你的 Claude 订阅，并按需填入备用 Anthropic Console API Key：

```bash
magpie plugin login claude-native
```

* **仅使用订阅**：在可选的 API Key 输入框直接回车留空。若本机 `claude` CLI 已登录会直接复用；未登录则自动拉起浏览器完成授权。
* **订阅 + API 余额兜底**：填入 Anthropic Console API Key（`sk-ant-api...` 或 `sk-ant-usr...`）。后续重新登录订阅时直接留空即可保留之前保存的备用 Key。

---

## 可选配置：开启 API 余额统计

如需在 Magpie 用量卡片上实时计算 Console 赠金/充值余额（或为 `sk-ant-usr...` 密钥指定计费工作区），可通过 `magpie plugin options` 传入工作区 ID 与额度信息：

```bash
magpie plugin options magpie-better-claude-support '{"workspace":"wrkspc_YOUR_ID","credit":{"usd":200,"since":"2026-10-01","expires":"2026-12-31T00:00:00Z"}}'
```

| 配置项 | 说明 |
| :--- | :--- |
| `workspace` | Anthropic Console 工作区 ID（`wrkspc_...`），使用 `sk-ant-usr...` 密钥时用于指定计费工作区。 |
| `credit.usd` | Anthropic Console 账单页显示的总赠金/额度（美元）。 |
| `credit.since` | 该笔额度的生效日期（`YYYY-MM-DD`）。 |
| `credit.expires` | 该笔额度的过期时间（ISO-8601 UTC 时间戳）。 |
| `defaultPermissionMode` | 网关直连调用时的默认权限模式（默认 `"yolo"` 自动批准，可选 `"default"` 或 `"plan"`）。 |
| `restoreSecrets` | 是否在本地工具执行前自动还原被 Magpie 网关脱敏的占位符（默认 `true`）。 |

---

## 许可

[MIT](LICENSE) © [SpookySandwich](https://github.com/SpookySandwich)
