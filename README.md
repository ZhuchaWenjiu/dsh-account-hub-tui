# dsh-account-hub-tui

dst（dsh-TUI）桥接插件：把 [dsh-account-hub](https://github.com/gurio-wine/dsh-account-hub)
的账号管理能力接到斜杠命令 `/account_hub` 上，在终端里完成 web「账号中心」面板的核心操作。

纯桥接，零构建，不引入任何 @deepseek-ai 依赖（全部通过 cordis 上下文延迟访问
`accountPool`、各 `*Auth` 与 `userQuestions` 服务）；dsh-account-hub 缺席时命令报友好错误，
不影响 profile 启动。

## 交互式流程

`/account_hub`（无参数）进入菜单：

1. **选择 provider** — 7 个 provider 的选项卡片（上下键 + Enter）
2. **未登录** → 直接弹出「登录新账号」引导；确认后打开浏览器授权，
   占位账号在授权完成后自动补全入池
3. **已登录** → 该 provider 的操作菜单：
   - 添加账号（浏览器登录新账号）
   - 切换优先账号（选账号移到自动选号首位）
   - 启用 / 停用账号
   - 积分余额（逐账号联网查询，含资源包明细）
   - 每日签到（签今天可签的账号，全部 provider 一并处理）
   - 续期账号凭据
   - 查看完整详情

首级菜单另有 **「★ 全部账号 · 余额与签到」**：先统一签到再逐 provider 查余额。

登录后，该 provider 的模型自动出现在 `/model` 模型选择器——模型按**账号池聚合**
（一个模型条目在全部账号间自动路由选号），这是 dsh-account-hub 适配器的既有设计，
本插件不重复注册任何模型。

## 参数式用法（快捷路径）

| 用法 | 作用 |
| --- | --- |
| `/account_hub <provider>` | 该 provider 的账号列表（▸ 标记自动选号将用的账号） |
| `/account_hub <provider> add` | 直接发起浏览器登录 |
| `/account_hub <provider> use <序号>` | 切换：把该账号移到手动顺序首位 |
| `/account_hub <provider> on <序号>` / `off <序号>` | 启用 / 停用 |
| `/account_hub <provider> refresh <序号>` | 按账号自己的凭据 ref 静默续期 |
| `/account_hub <provider> rename <序号> <昵称>` | 改昵称 |
| `/account_hub <provider> credits` | 该 provider 全部账号的积分余额（含资源包明细） |
| `/account_hub checkin` | 一键签到：签今天所有可签的账号（全 provider） |
| `/account_hub credits` | 所有已登录 provider 的余额汇总 |
| `/account_hub providers` | 列出 provider id |

`<provider>` ∈ `codearts` `buddy-cn` `buddy` `lobsterai` `trae-cn` `qoder` `qoder-cn`
（大小写与连字符不敏感，`buddycn` / `trae` / `qodercn` 也可）。

## 安装

### 一键安装（推荐）

前置：Node.js ≥ 20、pnpm ≥ 10、已装 dsh 且至少跑过一次 `dsh-tui`（profile 已初始化）。

```sh
git clone https://github.com/gurio-wine/dsh-account-hub-tui.git
cd dsh-account-hub-tui
bash install.sh
```

`install.sh` 会自动：放行 hub 的构建脚本白名单（allowBuilds）→ 安装上游
dsh-account-hub → 安装本插件 → 校验 profile 配置树。装完重启 dst 即可。

其他 profile：`PROFILE=你的profile名 bash install.sh`。

### 手动安装

```sh
# 1) 在 ~/.dsh/profiles/dsh-tui/pnpm-workspace.yaml 的 allowBuilds: 下加一行
#    dsh-account-hub@git+https://github.com/gurio-wine/dsh-account-hub.git: true
#    （没有 allowBuilds: 键就在文件末尾追加）
# 2) 安装上游 hub（账号池 / 登录 / 模型路由都来自它）
CI=true dsh plugin --profile dsh-tui add "https://github.com/gurio-wine/dsh-account-hub.git"
# 3) 安装本插件
CI=true dsh plugin --profile dsh-tui add "https://github.com/gurio-wine/dsh-account-hub-tui.git"
```

前置：同一 profile 必须已安装 dsh-account-hub（桥接插件只做管理入口，
账号池与模型路由都由 hub 提供）。

## 实现要点

- 「切换」= 重排手动顺序（`AccountPool.reorderAccounts` 的完整排列约束已处理），
  与 web 面板拖拽同语义。
- 登录与 web 面板 `account.create` RPC 同款时序：codearts / lobsterai / trae-cn /
  qoder / qoder-cn 走 `prepareLogin` → 占位条目 → 客户端开浏览器 →
  `persistLoginResult` 后台补全；buddy 系走 `login()` 一步式（完成时才入池，
  不建占位以免双条目）。失败自动移除占位，不留幽灵账号。
- 交互问卷走 `ctx.userQuestions.ask`（无 agent 请求，TUI 应答器刻意认领——
  dsh-auth `/auth` 向导同款通路）；服务不可用时自动回退文本概览。
- 打开浏览器：Windows 用 rundll32（避开 cmd start 吃 `&`），macOS `open`，
  Linux `xdg-open`。
