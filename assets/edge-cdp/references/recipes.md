# 配方

先 `edge_status` 确认可用，再 `edge_new_tab` 认领一个页签（下面用 `alice` 代替你的名字）。

## 1. 取正文（选择器兜底）

`edge_text` 取的是 `document.body.innerText`，导航栏和页脚会一起混进来。要更干净就自己指定容器：

```json
{ "tab": "alice", "expression": "(() => { const s = ['.content','article','#main','.main-content','body']; const el = s.map(x => document.querySelector(x)).find(Boolean); return (el.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim(); })()" }
```

先用 `[...document.querySelectorAll('div')].slice(0,20).map(d=>d.className)` 摸清 DOM 再说。

## 2. 表格 → JSON

```json
{ "tab": "alice", "expression": "(() => { const t = document.querySelector('table'); if (!t) return { ok: false }; const rows = [...t.querySelectorAll('tr')]; const head = [...rows[0].cells].map(c => c.innerText.trim()); return { ok: true, data: rows.slice(1).map(r => Object.fromEntries([...r.cells].map((c,i) => [head[i] || ('c'+i), c.innerText.trim()]))) }; })()" }
```

输出直接就是 JSON，存到你工作区的 `work/<任务>/data/x.json`。

## 3. 等动态列表加载完

```
edge_wait {tab, selector: ".item"}          # 等元素
edge_wait {tab, text: "共 12 条"}            # 等文字（更准，能等到数据渲染完）
edge_eval {tab, expression: "new Promise(r => setTimeout(r, 2000))"}   # 实在没标志物才用
```

`found: false` 表示没等到 —— 别当成功往下走。

## 4. 无限滚动到底

```json
{ "tab": "alice", "expression": "new Promise(r => { let last = -1, same = 0; const t = setInterval(() => { window.scrollTo(0, document.body.scrollHeight); const h = document.body.scrollHeight; same = (h === last) ? same + 1 : 0; last = h; if (same >= 5) { clearInterval(t); r({ height: h, items: document.querySelectorAll('.item').length }); } }, 600); setTimeout(() => { clearInterval(t); r({ timeout: true }); }, 30000); })" }
```

## 5. 翻页抓全部

先抓第 1 页，然后循环「点下一页 → 等列表变 → 再抓」。

判「换页了」别只看元素在不在（列表一直有），要记第一条的文字或链接，变了才算换页。
抓一批就先追加写文件，不要攒在内存里 —— 中途崩了不至于全丢。

## 6. iframe 里的课件 / 播放器

```
edge_frames {tab}                                  → 看 frame 列表
edge_text   {tab, frame: "/ananas/modules/video/"} → 进 frame 取正文
```

`frame` 的值要在列表里**唯一**，匹配多个会报错并列候选。

读命令（`edge_text` / `edge_html` / `edge_eval`）支持 `frame`；
`edge_click` / `edge_fill` 只作用于主文档。iframe 里点不动时，退路是在 frame 里用 `edge_eval` 派发事件 ——
但那对监听真实鼠标事件的课件常常无效，别硬试。

## 7. 判断是否还登录着

**不要读 cookie，不要碰 `var/profile/`。** 看页面本身：

```
edge_eval {tab, expression: "document.body.innerText.includes('退出登录') || !!document.querySelector('.user-avatar')"}
```

URL 被踹回 `/login`，或者正文里出现登录表单，就是掉登录了 —— **这时候停手，交给用户**，不要想办法绕过。

## 8. 长脚本

表达式一长，引号会把人逼疯。但工具参数是 JSON，比命令行安全得多；
仍然建议长表达式先写成 `.js` 文件，然后用 `edge_eval` 的 `file` 参数指过去。
文件里的内容必须是**单个表达式**（IIFE 或 Promise 都行），不要写 `return` 语句。

## 9. 截图取证

```
edge_shot {tab: "alice", file: "work/我的任务/shots/lesson-2.1.png"}
```

返回里带 `w` / `h`，长页面会自动整页截。交付时连尺寸一起说，方便判断是不是漏了底部。
路径建议写相对路径（相对你当前工作区），插件会解析成绝对路径。

## 10. 批量任务：先列清单再逐条

容易翻车的顺序是「边抓边决定抓什么」。稳妥的是三段：

1. 抓目录：`edge_eval` 返回 `[{title, url}]`，存 `data/manifest.json`；
2. 人过一眼清单（或至少打印条数让人确认）；
3. 逐条 `edge_navigate` → `edge_wait` → `edge_text`，每条落一个文件，失败的记进 `failures.json` 继续下一条。

中途出错不要重头再来 —— 清单里已有 `done` 标记，跳过即可。

## 11. 提交类动作（不可逆，固定按这个顺序）

勾任务点、交测验、提交表单都是本工作区的正常任务，但提交按钮点一次就是一次。四步走。

**第一步：先看清要交什么。** 别上来就点。

```json
{ "tab": "alice", "expression": "(() => { const qs = [...document.querySelectorAll('.question,.TiMu,.subject,li')]; return qs.slice(0,20).map((n,i) => ({ i, text: (n.innerText||'').replace(/\\s+/g,' ').slice(0,100) })); })()" }
```

**第二步：存一张「提交前」的截图。**

**第三步：按文字点，别猜 class。** 中文按钮的 class 常是随机哈希，文字才是稳定的：
`edge_click {tab, text: "提交"}`

点完等结果文字出现（不是死等固定秒数）：`edge_wait {tab, text: "已提交"}`

**第四步：留证并报告。** 截图 + 把分数/提示语读出来，写进结论。

### 注意

- 提交后**不要**因为没看到预期文字就再点一次。先 `edge_shot` 看一眼 —— 可能已经在「提交成功」页上了。
- 二次确认弹窗用 `edge_click {text: "确定"}` 点，别用 `edge_eval "confirm()"` 糊弄：那绕过真实交互路径，测不到真问题。
- 一次交多题时，先数一遍已选项和题目数对不对得上，再点提交。
- `edge_click` 按文字找时先找真正可点的元素，再退到只含文字的叶子节点；页面有两个同文字按钮时只会点第一个，需要精确时改用 selector。

## 12. 登录交接（本插件最重要的配方）

检测到登录页 / 验证码 / 风险提示时：

```
1. edge_shot  {tab, file: "work/<任务>/shots/login-needed.png"}
2. 一句话告诉用户要做什么（在哪个窗口、扫码还是输密码）
3. 停手等 —— 不要反复点、不要试 cookie、不要读 var/profile
4. 用户说好了 → edge_wait {tab, text: "<登录后的标志文字>"} → 确认后再继续
```

这条配方不写清楚，agent 就会在用户登录的过程中去点别的，或者干脆去想办法绕过验证 —— 两条都是坏路。
