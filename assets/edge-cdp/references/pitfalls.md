# 坑列表

按「现象 → 真正的原因 → 做法」记。前 10 条来自旧工作区的实测记录，后 4 条是插件化之后新增的。

## 1. 端口在监听，请求却不回包

```
端口在监听但 CDP 不回包
```

**原因**：浏览器启动到一半就死了，但监听套接字被内核残留着。Chromium 的多进程 IPC（mojo）建不起来时，
进程在 `platform_channel.cc:187` 抛 `Access denied (0x5)` 后崩掉，于是出现"能连上、零字节返回"这种特别像网络问题的现象。

**做法**：`edge_status` 会报 `stale-port`；`edge_stop` 清掉，再 `edge_start`。
判断服务活没活的唯一可靠依据是 `/json/version` 有没有返回 JSON，不是端口状态。

## 2. agent 自己起浏览器就崩

**原因**：agent 的 pwsh 工具调用跑在 DSH 的受限沙箱里（Windows 上是 restricted token + ACL）。
Chromium 需要创建命名管道做 IPC、需要给渲染进程授权，这两件事在低完整性令牌下都被拒。**带窗口和无头都一样崩。**

**做法**：**启动权只在插件手里**。`edge_start` 由 DSH 宿主进程直接 spawn，不经过沙箱。
用户也可以双击插件目录下的 `start-edge.cmd`（从资源管理器启动不受沙箱限制）。
不要在 pwsh 里 `Start-Process msedge` —— 那是旧工作区里那条"必须让用户双击"的坑的根源。

## 3. 关掉窗口之后，到底关没关干净

**原因**：旧实现里浏览器是从 agent 会话里 `Start-Process` 出来的，既不受 DSH 管理，也没有归属记录，
于是"我关了窗口"和"端口还占着"可能同时为真。

**做法**：插件启动 Edge 时加了 `--disable-background-mode`，并把它 detach 出 DSH 的会话树。
所以：**用户关窗口 = 浏览器退出 = 端口释放**，三者一致。
`edge_status` 用「登记的浏览器 UUID」对比「端口上实际回报的 UUID」来判断，pid 只是辅助（pid 会被复用）。

## 4. 截图截到上一屏的旧画面

**原因**：后台页签不产新帧。多 agent 并发时更隐蔽：谁调用 bringToFront，谁就把别人的页签挤到后台，
于是大家轮流截到对方的旧帧。

**做法**：`edge_shot` 内置等帧，且等帧有 1.5 秒上限（后台页签里 rAF 根本不跑）。
仍旧旧就先 `edge_navigate` 重进一次。**不要抢焦点**，那是在干扰用户和其他 agent。

## 5. `el.click()` 点了没反应

**原因**：多数单页应用和富课件监听的是真实鼠标事件序列，不是 DOM 的 `click()`。

**做法**：`edge_click` 走 `Input.dispatchMouseEvent`（mousePressed + mouseReleased），
先 `scrollIntoView` 再按元素中心坐标点。元素尺寸为 0 会直接报 `zero size`，多半是被 `display:none` 藏着。

## 6. 值填进去了，但提交后说没填

**原因**：直接 `el.value = x` 绕过了框架的值追踪。React/Vue 的受控组件只看得到自己 setter 里那次赋值。

**做法**：`edge_fill` 用原型上的原生 setter 赋值，再派发 `input` + `change`。
contenteditable 走另一条（设 `textContent` 后派发 `InputEvent`），`<select>` 按 value 或选项文字匹配。

## 7. 导航后永久卡在等加载

**原因**：先发 `Page.navigate` 再挂 `Page.loadEventFired` 监听 —— 页面够快时事件已经过去了，监听永远等不到。

**做法**：不用事件，轮询 `document.readyState === 'complete'`。慢就慢一点，不会卡死。

## 8. 第二个浏览器起不来，或者根本没开调试端口

**原因**：同一个 `--user-data-dir` 只能有一个浏览器实例。第二次启动会被已在跑的实例接管成一个新窗口，
命令行里的 `--remote-debugging-port` 被忽略 —— **看起来启动了，其实没开调试端口**。

**做法**：`edge_start` 是"探活优先、复用优先"：端口上已经有浏览器就直接复用，绝不新开窗口。
所以插件不会因为"我想用"就往用户桌面上再堆一个 Edge。

## 9. `newtab` 返回 405 Method Not Allowed

**原因**：Chromium 111+ 起 `/json/new` 只接受 `PUT`。

**做法**：客户端已经用 PUT。自己写 curl / fetch 时别用 GET。
另外 URL 不要整体 `encodeURIComponent` —— `?` 和 `#` 会被编掉。做法是先用 `/json/new?about:blank` 建空页签，
再用 `Page.navigate` 导航到真地址，完全绕开这个编码坑。

## 10. 页面明明有内容，`text` 却是空的

**原因**：内容在 iframe 里（课件、播放器、第三方嵌入基本都是）。

**做法**：`edge_frames` 看 frame 列表，读命令加 `frame: "<url 片段>"`。
片段要唯一，匹配到多个会报错并列出来。

## 11. 用户正在输入，agent 一个操作把光标抢走了

**原因**：有窗口的浏览器是**共享输入设备**。任何把窗口提到前台的调用，都会打断正在打字的人。

**做法**：插件不提供 bringToFront。需要用户看的时候，只用文字告诉他"请切到那个窗口"。
这条在有头模式下是硬约束，不是礼貌。

## 12. 认领记录还在，页签没了

**原因**：浏览器重启过，旧的 targetId 全部失效。

**做法**：认领记录里指向已消失页签的条目会在下次按名字查找时自动收回；剩下的用 `edge_prune` 归档。
归档不是删除：操作流水是唯一能证明"某个 agent 干了什么"的东西。

## 13. 记录文件带 BOM / 损坏

**原因**：Windows PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，而 `JSON.parse` 见到 BOM 直接抛。

**做法**：读记录时统一剥 BOM；实在解析不了的，`edge_tabs` 会列成 `{file, corrupt: true, reason}`。
**不会假装这个认领不存在** —— 静默丢归属比报错危险得多。

## 14. 插件改了代码却不生效

**原因**：技能文件（SKILL.md / references）是实时监听的，改了立刻生效；
但插件的 `lib/*.js` 是服务端代码，**必须重启 DSH** 才会重新加载。

**做法**：改技能内容不用重启；改工具实现要重启。两者别混。
