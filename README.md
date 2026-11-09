# dsh-notify-spirit

> DeepSeek Harness 插件：状态栏常驻鲸鱼图标显示会话状态，任务完成/阻塞时发系统通知，
> 会话等你授权或选择时把待决事项送进菜单栏——**不用切回 DSH 窗口也能处理完**。

macOS · DSH 0.2.2+

---

## 它解决什么

DSH 的授权卡和提问卡只在窗口里可见。你切到别的应用后，会话就卡在那里，
而屏幕上没有任何东西在等你——你甚至不知道它在等。

这个插件把这件事推到你眼前，并且**让你就地处理掉**：

- 菜单栏的鲸鱼图标用颜色告诉你现在有没有事
- 有会话完成或阻塞时弹系统通知（带问题上下文）
- 待决的授权/提问按顺序排在菜单栏里，点选项即可完成，不必回到窗口

## 安装

```bash
dsh plugin --profile <profile名> add dsh-notify-spirit
```

或从本地目录安装：插件管理器里选择该目录。装好后重启 DSH。

## 使用

### 图标状态

| 图标 | 含义 |
|---|---|
| 🐳 纯黑，无数字 | 空闲 |
| 🐳 纯黑 + 数字 | N 个会话正在运行 |
| 🐳 橙色 + 数字 | N 件事等你处理 |

图标是 template image，深色菜单栏下自动变白，和微信等系统图标一致。

### 菜单栏

```
🔐 批准 · 重构 registry          ← 待你处理，永远排最上面
   工具 bash 请求写入 workspace 外文件
   ───
   · 允许一次
   · 拒绝
   ───
   打开会话
────
🔘 选择 · 数据迁移                ← 多问题批次，逐题推进
   ✓ 分支：main
   ───
   2/2 目标环境
   · 生产
   · 预发
   ───
   打开会话
────
📁 skills（2）                   ← 运行中的会话，按 workspace 分组
   ⏳ 跑测试 · bash（3 分钟）
   ⏳ 整理笔记（刚开始）
────
隐藏图标
```

多问题批次**一次只显示一题**，答完自动推进，全部答完才整批提交
（DSH 要求每个问题都有答案，不能分批交回）。

### 通知

- 会话完成、失败、被拦截、需要你处理时弹出
- 同一条会话只保留一条通知（新通知顶替旧通知）
- 回到 DSH、或在菜单栏处理完之后，通知自动撤回
- 点击通知把 DSH 唤到前台

## 接管规则

插件只在**你不在看 DSH** 时接管待决请求。

```
请求到达
├─ DSH 在前台 → 直接放行，官方卡片正常出现，插件只显示不接管
└─ DSH 不在前台 → 先按住 3 秒（防抖）
    ├─ 3 秒内回到 DSH → 交还窗口，什么都没发生
    └─ 3 秒后仍不在 → 确认离开：菜单栏变橙 + 发通知
        ├─ 你在菜单栏处理 → 立即结算
        ├─ 你回到 DSH（持续 800ms）→ 交还窗口，通知撤回
        └─ 10 分钟仍未处理 → 强制交还，避免会话卡死
```

**为什么是 3 秒**：切换窗口时的一瞬间失焦不该抢走授权卡。
**为什么交还要等 800ms**：交还不可逆（`next()` 之后请求永久归窗口），
误交还意味着窗口里冒出卡片而你本不打算看它。

## 配置

全部可在插件设置里改，改动即时生效（无需重启）。

| 键 | 默认 | 说明 |
|---|---|---|
| `tray` | `true` | 显示状态栏图标 |
| `iconStyle` | `count` | 图标旁显示什么：`count` / `text` / `icon` |
| `showRunning` | `true` | 菜单里列出运行中的会话 |
| `trayRows` | `3` | 菜单里直接列出的待决条数 |
| `notifyCompleted` / `notifyFailed` / `notifyBlocked` | `true` | 各类通知开关 |
| `notifyAttention` | `true` | 需要授权/选择/输入时通知 |
| `sound` | `true` | 通知带提示音 |
| `burstWindowMs` | `4000` | 突发完成的合并窗口 |
| `claim` | `away` | `away`（不在前台才接管）/ `always` / `never` |
| `claimDelayMs` | `3000` | 接管前的防抖窗口 |
| `claimMaxHoldMinutes` | `10` | 最长按住多久，超时交还 |
| `focusPollMs` | `1000` | 多久检查一次 DSH 是否在前台 |
| `returnDebounceMs` | `800` | 回到前台持续多久才算真的要交还 |
| `claimApprovals` / `claimQuestions` | `true` | 分类接管开关 |

## 依赖

**插件本身零依赖。**

系统通知是可选的：需要 macOS 上的
[terminal-notifier](https://github.com/julienXX/terminal-notifier#download)
（`brew install terminal-notifier`，或从项目页下载）。

**为什么默认不带它**：本插件的通知只是提醒——授权和提问都在菜单栏里处理，
通知点开后也回到 DSH。为了一个提示功能在包里塞一个第三方二进制并不划算。

系统里没有装它时：

- 插件**不发通知**，避免留下无法撤回的死链
- 状态栏照常工作，图标变橙就说明有事等你
- 菜单底部会出现一条「系统通知需要 terminal-notifier」，点开是安装说明

装好之后不需要重装插件，最多等两秒（配置轮询）就会自动开始发通知。

## 已知限制

- **仅 macOS**。其他平台的状态栏与通知机制不同，尚未实现。
- **通知上看不到操作按钮**。`terminal-notifier` 只支持"点击整条通知"这一种交互，
  没有 action 机制；真正的通知按钮需要自建带 bundle id 的 helper App 并申请通知权限，
  目前未做。决策统一收在菜单栏，通知只负责叫你。
- **不装 terminal-notifier 就没有系统通知**，只有状态栏提示（见上文「依赖」）。
- **点击通知只唤醒 DSH，不定位到具体会话**。`openSession()` 是浏览器内 API，
  纯 Host 插件够不到；需要补一个极简 Client 半区（见 [TODO.md](./TODO.md)）。
- **交还后无法再接管**。`next()` 一旦调用，请求归官方 UI，插件失去控制权。
  所以交还后你若再次切出 DSH，该请求只能在窗口里处理。

## 开发

```bash
# 语法检查
node --input-type=module --check < index.js

# 日志（排查用）
tail -f ~/.dsh/storages/dsh-notify-spirit/notify-spirit.log
```

改代码后需要重新安装插件才会生效（`remove_bundle` + `install_bundle`）。

结构：

```
index.js            插件入口：接线、接管规则、通知派发
lib/config.js       配置 schema
lib/tracker.js      从 session/event 折叠会话状态
lib/claims.js       接管状态机（防抖、超时、向导式作答）
lib/view.js         菜单栏视图模型
lib/notify.js       系统通知（可选，用系统装的 terminal-notifier）
lib/tray/           状态栏图标驱动
assets/tray-darwin.js  JXA 菜单栏 helper
```

## License

MIT
