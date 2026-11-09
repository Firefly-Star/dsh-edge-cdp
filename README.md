# dsh-edge-cdp

一台**有窗口的、常驻的** Edge，给整个 DSH 的所有会话共用。

它解决三个具体问题，每个都是踩过的：

| 问题 | 这里的做法 |
|---|---|
| agent 在 pwsh 里起不来 Edge（`platform_channel.cc:187` 拒绝访问） | 启动权只归插件：由 DSH 宿主进程 spawn，不经过受限令牌 |
| 会话一结束，浏览器跟着没了 | 浏览器 detach 出会话树，DSH 重启也不影响；用户正在登录时不会被抽走 |
| "谁起的、我关了窗口到底关没关" 说不清 | `var/edge.json` 记录 pid + 浏览器 UUID + 启动者；UUID 对不上就绝不去关 |

**为什么必须有窗口**：agent 卡在登录、验证码、扫码、二次确认时，唯一的正路是把窗口交给用户。
无头浏览器遇到这些页面，agent 只剩"猜"和"绕"两条坏路。

## 它提供什么

**18 个工具**（`edge_*`）：状态、启停、页签认领与流水、导航、取正文/HTML、求值、iframe、真实点击、填表、等待、截图、归档。

**一个技能**（`edge-cdp`）：告诉 agent 怎么在有窗口的共享浏览器上干活，尤其是**怎么把登录交回给人**。

## 装

```powershell
# 只是看看会做什么
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DryRun

# 接线（并把旧工作区的浏览器 profile 迁过来）
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1

# 只接线，不搬 profile
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -SkipProfileMigration
```

脚本做两件事：改 `~/.dsh/profiles/web/package.json`（加依赖和 bundle，改前备份），
在 profile 的 `node_modules` 建一个目录 junction；然后把旧 profile 复制到 `var/profile`。

**装完必须重启 DSH** —— 服务端插件代码不是热加载的（技能文件是，`lib/` 不是）。

## 目录

```
dsh-edge-cdp/
  lib/index.js          插件入口：注册技能 provider + 工具
  lib/tools.js          18 个工具的定义与实现
  lib/core/             不含 SDK 依赖的纯 Node 核心，可单独测试
    paths.js            目录布局
    owner.js            归属登记（UUID 判定，不信 pid）
    launcher.js         argv 与 detached 启动
    lifecycle.js        复用 / 启动 / 关闭 / 四态判定
    records.js          页签认领、引用计数、操作流水、僵尸锁
    tabs.js             页签级操作与归档
    page.js             点击 / 填表 / 截图 / iframe
    cdp.js              CDP 传输
    frontmatter.js      SKILL.md 解析
  assets/edge-cdp/      技能：SKILL.md + references/
  bin/cdp.mjs           命令行壳（同一套 core）
  test/                 自测
  install.ps1           接线 + 迁移
```

**运行时数据不在这里**，在 `%USERPROFILE%\.dsh\edge-cdp\`（或 `$DSH_HOME/edge-cdp`）：

```
<DSH_HOME>/edge-cdp/
  profile/   浏览器 user-data-dir —— 登录态，等同密码
  tabs/      每个页签一条认领记录 + 操作流水
  logs/      浏览器日志
  edge.json  当前浏览器的归属登记
```

为什么分开放：这个包可以从 GitHub 安装，**升级时 pnpm 会整个替换包目录**。
profile 如果放在包里，一次 `pnpm update` 就会把你的登录态删掉。
`test/data-dir.mjs` 守着这条 —— 它会断言默认路径**不在包内**。

## 测试

```powershell
node test/all.mjs              # 一条命令跑全部七套
node test/all.mjs --with-launch  # 额外真启动一次浏览器（会弹窗口）
```

| 套件 | 证明什么 |
|---|---|
| `selftest` (23) | argv 不含 `--headless`、只绑回环、UUID 判定、引用计数、僵尸锁、归档、BOM |
| `compile-tools` (18) | 每个工具定义都能被编译 |
| `schema-parity` (60) | 本地 schema 编译器与真实 SDK **逐字节一致** |
| `plugin-entry` (10) | 插件在**无解析钩子**下能加载（等同 DSH 的 linked root 环境） |
| `cordis-context` (4) | 在**真实 Cordis 上下文**里挂载，且 `inject` 规则没被违反 |
| `wiring` (6) | profile 里是真正的链接、bundle 声明完整 |
| `live-tools` (7) | 对着真实浏览器执行：读正文、无主改动被拒、认领后求值留痕、拒绝关别人的浏览器 |

`schema-parity` / `cordis-context` 需要 `DSH_SDK_ROOT` 指向一个 DSH 安装（默认取本机那个）。
它们用真实 SDK 做对照，所以是唯一能发现"我的实现和宿主要求不一致"的地方。

## 三个踩过的坑（都写进了测试）

### 1. 顶层 import SDK 会让插件完全加载不了

```
edge-cdp (dsh-edge-cdp): failed to import:
  ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'
```

位于 profile 之外的插件（linked root）走 Node 原生解析，拿不到安装范围内的包。
**修法**：插件零外部依赖 —— 自带 `lib/core/tool-schema.js`（`defineTool` 等价实现），
`BUNDLED_SKILL_RANK` 内联。`schema-parity` 用真实 SDK 对照，保证两者不漂移。

### 2. 读未在 `inject` 里声明的服务会抛错

```
edge-cdp (dsh-edge-cdp): Error: cannot get property "skills" without inject
```

`inject` 是**硬依赖声明**，不是访问许可证：没声明就访问要抛错，声明了则服务缺席时插件不启动。
**修法**：`inject` 只留 `tools`，其余服务一律通过 `ctx.get(name)` 取，并且**检查形状**
（不只是存在），避免别的 provider 放了个形状不对的对象就把宿主带崩。
`cordis-context` 用真实 Cordis 验证这两条。

### 3. junction 可能根本不是"链接"

`install.ps1` 建 `node_modules` 链接时，如果目标路径**已经存在**，
`New-Item -ItemType Junction` 会静默不生效，留下一个普通目录。

这不影响 Node 解析 —— 插件照样能被 import，所以错误完全不可见。
但 DSH 的 `linkedProfileRoots` 用的是 `dirent.isSymbolicLink()`，
普通目录不是链接，于是**整个 bundle 根本不会被加载**，表现为"技能就是不出现"。

**修法**：用 `cmd /c mklink /J`，然后验证 `Attributes` 里真的有 `ReparsePoint`。
`test/wiring.mjs` 用同一个判据 `lstatSync().isSymbolicLink()` 守着这条。

## 安全边界

- **`var/profile` 是登录态，等同密码**：不读、不导出、不提交。
- **调试端口只绑 `127.0.0.1`**，argv 里有断言守着，不做端口转发。
- **`edge_stop` 只关自己启动的**：UUID 对不上就拒绝，不碰用户的日常浏览器。
- **认领来的页签永远不替你关**：`origin=adopted` 的页面只释放引用。
- **操作流水归档不删除**：`close` 清零时记录进 `tabs/archive/`，那是唯一能证明谁干过什么的证据。

## 已知限制

- Windows 专用（Edge + 目录 junction + 进程语义）。
- 有头浏览器共享输入设备：插件**不提供** bringToFront，抢焦点会打断正在打字的人。
- iframe 里的真实点击/填表仍不支持：`frame` 只对读命令生效。
- 一个 `--user-data-dir` 只能有一个实例：所以 `edge_start` 永远是"复用优先"，不会开第二个窗口。
