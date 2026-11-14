/**
 * 卡住就停（stuck-guard）：把「连续换招但没结果时先停下来问人」做成可分发、可检查的机制。
 *
 * 两件事，都挂在系统提示上：
 * 1. 注册一个 section 放「升级协议」正文——每次请求都带着它，规则随插件走。
 * 2. 监听 `tool/result`：连续失败到阈值时，再注册一个 `:checkpoint` section，
 *    把失败证据（工具名 + 报错首行）摆进提示；成功或新用户指令到达时撤掉。
 *
 * 这里只做提醒，不做硬阻塞：连续失败是确定性信号，「同一个问题」不是。
 * 判定「是不是同一个坑」留给模型结合证据判断，插件负责在正确的时间点把证据摆出来。
 *
 * 所有钩子都在 try/catch 内，任何异常都只写日志，绝不能让插件的失败影响对话。
 */
import z from '@deepseek-ai/schemastery'
import { appendFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 诊断日志：写到 `<DSH_HOME>/dsh-stuck-guard.log`，每进程最多 200 行，文件超过 512KB 时轮转。
 * 插件是软约束，出问题时唯一能拿到的证据就是它——所以宁可多写一行，也不要静默失败。
 */
const DIAG_LOG = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-stuck-guard.log')
const DIAG_MAX_BYTES = 512 * 1024
let diagBudget = 200
let diagRotated = false

function rotateDiag() {
  if (diagRotated) return
  diagRotated = true
  try {
    if (statSync(DIAG_LOG).size > DIAG_MAX_BYTES) renameSync(DIAG_LOG, `${DIAG_LOG}.1`)
  } catch {}
}

function diag(event, data = {}) {
  if (diagBudget <= 0) return
  diagBudget -= 1
  rotateDiag()
  try {
    appendFileSync(DIAG_LOG, `${JSON.stringify({ t: new Date().toISOString(), event, pid: process.pid, ...data })}\n`, 'utf8')
  } catch {}
}

// 模块被真正 import 到的证据：只要这行在，就说明 dsh 加载到了这个文件。
diag('module-loaded', { file: import.meta.url })

/** 本插件依赖的服务：systemPrompt 只能通过 inject 取用。 */
export const inject = ['systemPrompt']

/**
 * 行配置。
 *
 * 带 `.volatile()` 的字段改动后原地生效，会出现在 Settings 的配置表单里（表单只列 volatile 字段）；
 * 其余字段改完要重启插件（cordis.patch.yml 或插件开关）。
 */
export const Config = z.object({
  /** 关掉后插件不注册任何 section。 */
  enabled: z.boolean().default(true),
  /** 连续失败多少次触发一次检查点。volatile：改完立即生效。 */
  failureThreshold: z.number().default(3).volatile(),
  /** 是否把协议正文放进系统提示。改动需要重新加载插件。 */
  injectProtocol: z.boolean().default(true),
  /** 是否注册检查点。volatile：改完立即生效。 */
  injectReminder: z.boolean().default(true),
  /** 不参与计数的工具名。volatile：改完立即生效。 */
  ignoreTools: z.array(z.string()).default([]).volatile(),
  /** 检查点里最多带几条证据。volatile：改完立即生效。 */
  maxEvidence: z.number().default(3).volatile(),
  /** 最多记住多少个会话的状态，超出后丢弃最早的。 */
  maxSessions: z.number().default(200),
})

/** 协议正文的标题，出现在系统提示里，用来认出这段规则来自本插件。 */
const PROTOCOL_HEADER = '[升级协议 · 由 dsh-stuck-guard 注入]'

/** 停机检查点的标题。 */
const REMINDER_HEADER = '[卡住检查点 · dsh-stuck-guard]'

/**
 * 协议正文。这是唯一来源：插件装到哪台机器，规则就跟到哪台机器。
 * 改规则只改这里，不要在别处再抄一份。
 */
const PROTOCOL = [
  PROTOCOL_HEADER,
  '适用本会话全程。目的不是少干活，而是不要在没有新信息时无限换招。',
  '',
  '一、什么时候停（满足任一条就停，不再开新尝试）',
  '1. 同一目标连续 3 次「换了实招」仍失败，且失败原因同类（同一个拦截 / 同一个报错 / 同一个挑战页）。',
  '2. 同一问题已消耗约 20 次以上工具调用或 15 分钟以上，且没有拿到任何新证据。',
  '3. 失败来自对方的主动防御：Cloudflare / 验证码 / WAF / 风控 / 403 挑战页 / 需要人机验证。',
  '4. 下一步只能靠猜——手里没有能证伪假设的新信息。',
  '',
  '二、什么算一次尝试',
  '算：换入口、换协议、换端点、换凭据来源、换执行环境、换数据源。',
  '不算：改参数、改 UA、改 header、加重试、加 sleep、换同类库、把同一请求再发一遍。',
  '同一招的微调合并记为 1 次。',
  '',
  '三、停下时发什么（一次说完，不超过 15 行，然后结束回合等指令）',
  '- 目标：一句话。',
  '- 已试：方法 | 结果 | 关键报错，一行一条，不贴长日志。',
  '- 已排除：由上面能确定不成立的假设。',
  '- 还没排除的：最多 3 条，标出最可能的一条。',
  '- 我的判断：技术不可行 / 只是没找对路。',
  '- 选项：A 我继续（按新思路 X 再试 N 次）；B 你提供 Y（cookie / API key / 样本 / 截图 / 已登录浏览器）；C 换方案（官方接口、公开数据源、本地缓存、人工处理）。',
  '- 最后直接问：你有方案吗？要我按哪个走？',
  '',
  '四、停下之后',
  '用户说继续 → 只执行列出的新思路，最多再 N 次（默认 3），再卡住再停，不叠加。',
  '用户没回 → 不动手，禁止「顺便再试一个」。用户给了方案 → 照做，不插入自己的尝试。',
  '',
  '五、不要停的情况',
  '可自纠的小错（拼写、路径、缺依赖、参数写错、语法错）直接修，不报告。',
  '报错明确指向下一步（编译错误、栈回溯、类型错误）继续查，但同类失败累计到 3 次照样停。',
  '',
  '六、硬红线',
  '验证码 / 挑战页 / 人机验证：不尝试破解（不打码、不伪造 token 与指纹、不用绕过服务），按第一条停下并说明「对方在主动阻止自动化」。',
  '反代或抓取第三方内容之前，先说出一条不依赖对方放行的 Plan B（官方 API、公开 CDN、用户手动提供、本地已有缓存）。没有 Plan B 就先补，再动手。',
].join('\n')

/**
 * 读一个配置项：声明了 Config 时字段是带 `.get()` 的引用，单元测试里直接传普通对象。
 * @param config - 行配置。
 * @param key - 字段名。
 * @returns 当前值，缺失时 undefined。
 */
function readConfig(config, key) {
  const field = config?.[key]
  if (field !== undefined && typeof field?.get === 'function') return field.get()
  return field
}

/** 一个会话的实时状态。 */
function createState() {
  return {
    /** 连续失败的次数。 */
    failures: 0,
    /** 触发阈值后置位，避免同一次卡住重复注册检查点。 */
    pendingReminder: false,
    /** 触发时的失败次数，用于措辞。 */
    triggeredAt: 0,
    /** callId -> 工具名，供 tool/result 回填证据。 */
    calls: new Map(),
    /** 最近的失败证据。 */
    evidence: [],
  }
}

/**
 * 从工具结果消息里取出完整文本（未截断），失败判定要用到末尾的退出码标记。
 * @param message - ToolResultMessage。
 * @returns 展平后的全文。
 */
function messageText(message) {
  const parts = []
  for (const block of message?.content ?? []) {
    if (typeof block?.text === 'string' && block.text.trim() !== '') parts.push(block.text.trim())
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * 取一段可读的失败证据。
 * @param message - ToolResultMessage。
 * @returns 展平后的前 240 个字符。
 */
function resultText(message) {
  const text = messageText(message)
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}

/**
 * 判断一次工具调用是不是失败。
 *
 * 三个信号缺一不可地覆盖不同工具：抛错（error）、工具自己标了 isError、以及 shell 的非零退出码
 * （shell 工具只在结果文本末尾追加 `[exit code: N]`，不设 isError——这是最常见的失败形态）。
 */
function looksFailed(data) {
  if (data?.error !== undefined) return true
  if (data?.message?.isError === true) return true
  return /\[exit code: (?!0\])\d+\]/.test(messageText(data?.message))
}

/**
 * 生成停机检查点。
 * @param state - 会话状态。
 * @param threshold - 触发阈值。
 * @param limit - 证据条数上限。
 * @returns 检查点正文。
 */
function reminderText(state, threshold, limit) {
  const lines = [
    REMINDER_HEADER,
    `最近连续 ${state.triggeredAt || threshold} 次工具调用失败，且看起来是同一类失败。按「升级协议」现在该停，不是再换一招。`,
  ]
  const evidence = state.evidence.slice(-limit)
  if (evidence.length > 0) {
    lines.push('插件抓到的证据（最近几条，可直接写进汇报）：')
    for (const item of evidence) lines.push(`- ${item.tool} | ${item.text}`)
  }
  lines.push(
    '现在必须做：结束本回合，用不超过 15 行汇报——目标 / 已试方法表 / 已排除的假设 / 剩余可能 / 你的判断 / A、B、C 三个选项，并直接问「你有方案吗？要按哪个走？」。',
    '这之后不要再发新的工具调用去「再试一次」；用户说继续，才按你列出的新思路再试。',
  )
  return lines.join('\n')
}

/**
 * 注册插件。宿主通过 cordis 调用本函数，配置来自 cordis.patch.yml 的同名行。
 * @param ctx - 插件上下文。
 * @param config - 行配置（声明了 Config 后是带引用的对象）。
 */
export function apply(ctx, config = {}) {
  if (readConfig(config, 'enabled') === false) return
  const threshold = () => readConfig(config, 'failureThreshold') ?? 3
  const maxEvidence = () => readConfig(config, 'maxEvidence') ?? 3
  const injectReminder = () => readConfig(config, 'injectReminder') !== false
  const injectProtocol = readConfig(config, 'injectProtocol') !== false
  const ignoreTools = () => new Set(readConfig(config, 'ignoreTools') ?? [])
  const maxSessions = () => readConfig(config, 'maxSessions') ?? 200
  diag('apply', { threshold: threshold(), protocol: injectProtocol, reminder: injectReminder() })

  // 协议正文进系统提示：不依赖 inbox 投递、不依赖 step 边界，每一次请求都带着它。
  // 检查点是**另一个** section：section 同名只能注册一次（再注册会抛错），
  // 所以卡住时注册 `:checkpoint`，恢复时调用它返回的 disposer 撤掉。
  let order = 500
  let checkpointDispose
  try {
    order = ctx.systemPrompt.getSectionOrder('DSH_STUCK_GUARD')
  } catch {}
  if (!Number.isFinite(order)) order = 500

  if (injectProtocol) {
    try {
      ctx.systemPrompt.section({ name: 'dsh-stuck-guard:protocol', order, text: PROTOCOL })
      diag('section', { registered: true, order })
    } catch (error) {
      diag('error', { where: 'section', message: String(error) })
    }
  }

  const hideCheckpoint = () => {
    if (checkpointDispose === undefined) return
    try {
      checkpointDispose()
      diag('section', { checkpoint: false })
    } catch (error) {
      diag('error', { where: 'hide-checkpoint', message: String(error) })
    }
    checkpointDispose = undefined
  }

  const showCheckpoint = (text) => {
    if (!injectReminder() || text === '') return
    hideCheckpoint()
    try {
      const disposer = ctx.systemPrompt.section({ name: 'dsh-stuck-guard:checkpoint', order: order + 1, text })
      checkpointDispose = typeof disposer === 'function' ? disposer : undefined
      diag('section', { checkpoint: true, disposable: typeof disposer === 'function', length: text.length })
    } catch (error) {
      diag('error', { where: 'checkpoint', message: String(error) })
    }
  }

  const states = new Map()

  const log = (level, message) => {
    try {
      const sink = ctx.logger?.[level]
      if (typeof sink === 'function') sink.call(ctx.logger, `dsh-stuck-guard: ${message}`)
    } catch {}
  }

  const idOf = (session) => {
    try {
      return String(session?.id ?? session?.header?.id ?? '?')
    } catch {
      return '?'
    }
  }

  const stateFor = (key) => {
    let state = states.get(key)
    if (state === undefined) {
      state = createState()
      states.set(key, state)
      if (states.size > maxSessions()) {
        const oldest = states.keys().next().value
        if (oldest !== undefined) states.delete(oldest)
      }
    }
    return state
  }

  // 失败计数：只认 tool/result 的结构化失败标记，不做文本猜测。
  try {
    ctx.on('session/event', (session, event) => {
      try {
        const key = idOf(session)
        const state = stateFor(key)
        const type = event?.type
        if (type === 'tool/call') {
          const name = typeof event.data?.name === 'string' ? event.data.name : '?'
          state.calls.set(event.data?.callId, name)
          if (state.calls.size > 32) state.calls.delete(state.calls.keys().next().value)
          return
        }
        if (type === 'tool/result') {
          const data = event.data ?? {}
          const callId = data.message?.toolCallId
          const name = state.calls.get(callId) ?? '?'
          state.calls.delete(callId)
          if (ignoreTools().has(name)) return
          const failed = looksFailed(data)
          if (failed) {
            state.failures += 1
            state.evidence.push({ tool: name, text: resultText(data.message) || (data.error?.name ?? 'failed') })
            if (state.evidence.length > 8) state.evidence.shift()
            if (state.failures >= threshold() && !state.pendingReminder) {
              state.triggeredAt = state.failures
              diag('threshold', { failures: state.failures })
              state.pendingReminder = true
              state.failures = 0
              showCheckpoint(reminderText(state, threshold(), maxEvidence()))
            }
          } else {
            state.failures = 0
            // 一旦成功，就不再算「卡住」：检查点立刻撤掉，下次重新累计。
            if (state.pendingReminder) {
              state.pendingReminder = false
              hideCheckpoint()
            }
          }
          return
        }
        // 新的一轮用户指令 = 新预算：计数清零，检查点撤回。
        if (type === 'user/message') {
          if (event.data?.source?.kind === 'runtime-context') return
          state.failures = 0
          state.pendingReminder = false
          hideCheckpoint()
        }
      } catch (error) {
        diag('error', { where: 'session-event', message: String(error) })
        log('warn', `session event skipped: ${String(error)}`)
      }
    })
  } catch (error) {
    diag('error', { where: 'session-hook', message: String(error) })
    log('warn', `cannot watch session events: ${String(error)}`)
  }

  log('info', `loaded (threshold=${threshold()}, protocol=${injectProtocol})`)
}
