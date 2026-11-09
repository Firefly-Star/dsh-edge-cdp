---
name: edge-cdp
description: 用 DSH 里那台常驻的、**有窗口的** Edge 干活：读页面正文与表格、进 iframe 取课件内容、真实点击与填表、截图取证、翻页抓取、登录交接。任务需要"看某个真实网页"或"在网页上点/填/抓"时用它。
whenToUse: 内容必须靠真实浏览器渲染、登录态或页面 JS 才能拿到时；需要用户亲手登录、输验证码、确认提交时。静态公开页面先用 web_fetch，更省。
---

# Edge/CDP 操作手册（插件版）

这台 Edge 由 **dsh-edge-cdp 插件**托管：有窗口、常驻、多个 agent 共用。
你看得见它，用户也看得见它 —— 这正是重点：**遇到登录、验证码、二次确认，交回给用户，不要自己硬闯。**

## 一、先看状态，再动手

```
edge_status        → 浏览器在不在、是不是插件起的、谁起的、端口、profile 在哪
edge_start         → 没起就起；已经在跑就复用（不会开第二个窗口）
```

`edge_status` 的 `state` 有四种，处理方式不同：

| state | 含义 | 该做什么 |
|---|---|---|
| `running` | 插件起的，可用 | 直接用 |
| `foreign` | 端口上有浏览器，但不是插件起的 | 可以用，但 `edge_stop` 不会替你关；别去关它 |
| `stale-port` | 端口占着但 CDP 不回包（启动到一半死掉） | 先 `edge_stop` 清掉，再 `edge_start` |
| `down` | 没在跑 | `edge_start` |

**不要**用 pwsh 去 `Start-Process msedge`：agent 的工具调用跑在受限令牌下，Edge 在那种令牌里起不来
（日志里是 `platform_channel.cc:187 ... Access denied (0x5)`）。启动权只在插件手里。

## 二、认领一个页签

多个 agent 共用一台浏览器，所以每个页签有归属：

```
edge_tabs                       → 列出页签、认领者、失效记录、损坏记录
edge_new_tab  {}                 → 新建并认领（tab=你的名字）
edge_claim    {tab, targetId}    → 认领一个已存在的页签（可以多人认领同一个）
edge_release  {tab}              → 只释放你自己那份引用
edge_tabs_log {tab}              → 谁、何时、做了什么
```

**接管别人动过的页签之前，先看 `edge_tabs_log`。** 页面变样了不是玄学，流水里有答案。

## 三、页面操作

| 目标 | 工具 |
|---|---|
| 跳转并等就绪 | `edge_navigate {tab, url}` |
| 取正文 | `edge_text {tab}` |
| 取 HTML | `edge_html {tab}` |
| 跑 JS | `edge_eval {tab, expression}` |
| 看有哪些 iframe | `edge_frames {tab}` |
| 进 iframe 取正文/求值 | 加 `frame: "<url 片段>"` |
| 真实鼠标点击 | `edge_click {tab, selector}` 或 `{tab, text: "按钮文字"}` |
| 填输入框/下拉框 | `edge_fill {tab, selector, value}` |
| 等元素或文字 | `edge_wait {tab, selector}` 或 `{tab, text: "已完成"}` |
| 截图 | `edge_shot {tab, file}` |

`edge_wait` 未命中返回 `found:false`，**不要**当成功继续往下走。

## 四、登录 / 验证码：交接给用户，别绕

这是本插件存在的理由之一。检测到这些信号就停下来：

- URL 跳到 `/login`、`/signin`、`passport.*`、`*/auth/*`
- 正文出现 登录 / 扫码 / 验证码 / 人机验证 / 二次验证 / 授权
- 页面弹窗要求输入手机号或验证码

标准动作，四步：

1. `edge_shot` 截一张，存到**你当前工作区**的 `work/<任务>/shots/` 下；
2. 一句话说清「卡在哪、需要你做什么」（例如「请在弹出的 Edge 窗口里扫码登录，完成后告诉我」）；
3. **停手等**。不要反复点、不要试 cookie、不要读浏览器 profile；
4. 用户说好了，用 `edge_wait {tab, text: "<登录后的标志文字>"}` 确认，再接着干。

用户的 profile 等同密码：**不读 `var/profile/`、不导出 cookie、不做端口转发。**

## 五、共享页签的纪律

1. **一条命令一个归属**：改页面的操作必须带 `tab`，写进流水，能追到人；只读操作可以只用 `targetId`。
2. **不要抢焦点**：不要调用任何把窗口提到前台的接口。用户可能正在这个窗口里打字。
3. **不要开第二个窗口**：`edge_start` 已经是"复用优先"，别绕过它自己开。
4. **收工只释放自己的引用**：`edge_release {tab}`。计数没归零就不关页签；认领来的页面永远不会被你关。
5. **提交类动作**（任务点、测验、表单）：动手前一句话说清要提交什么 → `edge_shot` 存证 → 点一次 → 等结果文字 → 再 `edge_shot`。
   **失败就停，不要连点**；连点会把数据弄脏。

## 六、产出写哪

插件有自己的 `var/`（profile、页签记录、日志），**那不是给你放产出的**。
你的截图和数据一律写**你当前工作区**的 `work/<任务名>/`：`data/` 放抓下来的原始数据，`shots/` 放截图。

## 七、报错对照

| 报错 | 含义 | 处理 |
|---|---|---|
| `连不上 http://127.0.0.1:9222` | 浏览器没在跑 | `edge_start` |
| `端口在监听但 CDP 不回包` | 陈旧端口 | `edge_stop` 后 `edge_start` |
| `有 N 个页签，且没有指定 tab` | 保护性拒绝 | 补 `tab` 或 `targetId` |
| `没有匹配 "..." 的 frame` | frame 片段不对 | 先 `edge_frames` |
| `点不到 ...` | 元素不存在或尺寸为 0 | 先 `edge_shot` 看一眼，再 `edge_wait` |
| `平台错误 / 权限` | 浏览器被非插件方式启动过 | 交给用户，或 `edge_stop` 后用 `edge_start` 重来 |

更细的配方见 `references/recipes.md`，坑的完整列表见 `references/pitfalls.md`。
