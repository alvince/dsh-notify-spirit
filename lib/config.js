/**
 * The plugin's Config schema, mounted as the `notify-spirit` row's `config`.
 *
 * Every user-tunable field is `.volatile()`: the Loader then updates the live
 * value in place instead of restarting the plugin, so the plugin reads it with
 * `.get()` at use time and a flipped switch applies within one tick.
 *
 * `@deepseek-ai/schemastery` comes from the Harness installation, not from a
 * dependency of this package: profile-linked bundles resolve their real path,
 * which has no `node_modules` of its own (see lib/runtime-deps.js). When it
 * cannot be loaded at all, `Config` is exported as `undefined`; the Loader then
 * passes the raw row config through and the plugin still runs without settings
 * validation.
 */
import { loadHarnessPackage } from './runtime-deps.js'

const z = await loadHarnessPackage('@deepseek-ai/schemastery')

/** Notification channels: where a notice is shown. */
const CHANNELS = [
  z?.const('auto').description('自动：有 DSH 窗口时交给窗口，没有窗口时由系统弹'),
  z?.const('client').description('只交给 DSH 窗口'),
  z?.const('system').description('只由系统弹（适合 dsh web / 命令行）'),
  z?.const('off').description('不弹通知（只看状态栏）'),
].filter(Boolean)

/** When this plugin may take a pending decision away from the window. */
const CLAIM_MODES = [
  z?.const('away').description('窗口不在前台时由本插件接管（推荐）'),
  z?.const('always').description('总是接管，窗口里不再出现该决策卡'),
  z?.const('never').description('从不接管，只显示通知'),
].filter(Boolean)

/** What the menu-bar title shows beside the icon. */
const ICON_STYLES = [
  z?.const('count').description('只显示待决策数量'),
  z?.const('text').description('文字：待决 1 / 运行中 2'),
  z?.const('icon').description('只显示图标'),
].filter(Boolean)

export const Config = z === undefined ? undefined : z.object({
  // ---- 状态栏 ------------------------------------------------------------
  tray: z.boolean().default(true).description('显示状态栏图标（macOS；其他平台忽略）').volatile(),
  iconStyle: z.union(ICON_STYLES).default('count').description('菜单栏图标旁显示什么').volatile(),
  showRunning: z.boolean().default(true).description('菜单里列出正在运行的会话').volatile(),
  trayRows: z.number().min(1).max(10).default(3).description('菜单里直接列出的待决策条数，其余折进子菜单').volatile(),

  // ---- 通知 --------------------------------------------------------------
  notifyCompleted: z.boolean().default(true).description('任务完成时通知').volatile(),
  notifyFailed: z.boolean().default(true).description('任务失败时通知').volatile(),
  notifyBlocked: z.boolean().default(true).description('会话被 block 时通知').volatile(),
  notifyAttention: z.boolean().default(true).description('需要授权 / 选择 / 输入时通知').volatile(),
  channel: z.union(CHANNELS).default('auto').description('通知通道').volatile(),
  suppressWhenFocused: z.boolean().default(true).description('正在看这个会话时不弹').volatile(),
  sound: z.boolean().default(true).description('系统通知带提示音').volatile(),
  burstWindowMs: z.number().min(0).max(60000).default(4000)
    .description('突发完成的合并窗口（毫秒），0 表示不合并').volatile(),

  // ---- 决策接管 ----------------------------------------------------------
  claim: z.union(CLAIM_MODES).default('away')
    .description('何时由本插件接管待决事项；接管后窗口里不再出现该决策卡').volatile(),
  claimDelayMs: z.number().min(0).max(30000).default(3000)
    .description('请求到达后先按住这么久；期间回到 DSH 就交还窗口').volatile(),
  claimMaxHoldMinutes: z.number().min(1).max(120).default(10)
    .description('最长按住多久，超时交还窗口避免会话卡死').volatile(),
  focusPollMs: z.number().min(250).max(10000).default(1000)
    .description('多久检查一次 DSH 是否回到前台（毫秒）').volatile(),
  returnDebounceMs: z.number().min(0).max(10000).default(800)
    .description('DSH 需持续在前台这么久才把待决请求交还窗口（毫秒）；交还不可撤销，太短会误交还').volatile(),
  claimApprovals: z.boolean().default(true).description('接管工具调用授权').volatile(),
  claimQuestions: z.boolean().default(true).description('接管提问 / 选择 / 计划确认').volatile(),
  remindEveryMinutes: z.number().min(0).max(240).default(0)
    .description('未处理的决策每隔几分钟再提醒一次，0 表示不提醒').volatile(),

  // ---- 集成 --------------------------------------------------------------
  localEndpoint: z.boolean().default(true)
    .description('开放 /notify-spirit/* 供通知按钮与命令行回调').volatile(),
  terminalNotifier: z.boolean().default(true)
    .description('使用系统自带的 terminal-notifier 发送可撤回的通知（需自行安装；未安装时只在状态栏提示）').volatile(),
  locale: z.union([
    z.const('auto').description('跟随 DSH 的界面语言'),
    z.const('zh').description('中文'),
    z.const('en').description('English'),
  ]).default('auto').description('通知与菜单文案的语言').volatile(),
})

export default Config
