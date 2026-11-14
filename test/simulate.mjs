/**
 * 离线自测：不启动 DSH，用最小假 ctx 跑一遍插件的核心行为。
 * 用法：node test/simulate.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/**
 * 造一套独立的假宿主：事件总线 + 假 systemPrompt。
 * @param config - 传给 apply 的行配置。
 */
function harness(config) {
  const listeners = new Map()
  const sections = []
  const session = { id: 's1', header: { origin: 'root' } }

  const ctx = {
    logger: { info() {}, warn() {} },
    on(type, fn) {
      const list = listeners.get(type) ?? []
      list.push(fn)
      listeners.set(type, list)
      return () => {}
    },
    effect() {},
    systemPrompt: {
      getSectionOrder: () => 10,
      // 真实实现返回 disposer，撤销用；假实现照做，才能测到「撤回」。
      section: (options) => {
        sections.push(options)
        return () => {
          const index = sections.indexOf(options)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    get() {
      return undefined
    },
  }

  const emit = (type, ...args) => {
    for (const fn of listeners.get(type) ?? []) fn(...args)
  }

  const userMessage = () =>
    emit('session/event', session, {
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] },
    })

  let seq = 0
  const toolResult = (name, { failed, text }) => {
    const callId = `call-${(seq += 1)}`
    emit('session/event', session, { type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: '{}' } })
    emit('session/event', session, {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'tool', toolCallId: callId, isError: failed, content: [{ type: 'text', text }] },
        ...(failed ? { error: { name: 'ToolError', code: 'failed' } } : {}),
      },
    })
  }

  const latest = () => sections[sections.length - 1]

  apply(ctx, config)
  return { session, emit, userMessage, toolResult, sections, latest }
}

// A. 协议进系统提示
{
  const main = harness({ failureThreshold: 3 })
  assert.equal(main.sections.length, 1, '启动时应注册协议 section')
  assert.equal(main.latest().name, 'dsh-stuck-guard:protocol')
  assert.match(main.latest().text, /升级协议/)
  assert.match(main.latest().text, /你有方案吗/)

  // B. 阈值：另注册一个 checkpoint section，带证据
  main.toolResult('pwsh', { failed: true, text: 'curl: (7) Failed to connect' })
  main.toolResult('pwsh', { failed: true, text: 'HTTP 403 Cloudflare challenge' })
  assert.equal(main.sections.length, 1, '未到阈值不应加 section')

  main.toolResult('pwsh', { failed: true, text: 'cf-chl challenge platform' })
  assert.equal(main.sections.length, 2, '到阈值应加 checkpoint section')
  assert.equal(main.latest().name, 'dsh-stuck-guard:checkpoint')
  assert.match(main.latest().text, /卡住检查点/)
  assert.match(main.latest().text, /Cloudflare challenge/, '应带失败证据')
  assert.match(main.latest().text, /你有方案吗/)

  // C. 只加一次；成功调用后撤掉并重新累计
  assert.equal(main.sections.length, 2, '连续失败不应重复加')
  main.toolResult('pwsh', { failed: false, text: 'ok' })
  assert.equal(main.sections.length, 1, '成功应撤掉 checkpoint')
  assert.doesNotMatch(main.latest().text, /卡住检查点/)
  main.toolResult('pwsh', { failed: true, text: 'boom 1' })
  main.toolResult('pwsh', { failed: true, text: 'boom 2' })
  assert.equal(main.sections.length, 1, '成功后需要重新累计')
  main.toolResult('pwsh', { failed: true, text: 'boom 3' })
  assert.equal(main.sections.length, 2, '再次到阈值应再次加 checkpoint')

  // D. 用户新消息撤掉检查点，协议还在
  main.userMessage()
  assert.equal(main.sections.length, 1, '用户新消息应撤掉 checkpoint')
  assert.match(main.latest().text, /升级协议/)
  assert.doesNotMatch(main.latest().text, /卡住检查点/)
}

// E. 忽略名单
{
  const relaxed = harness({ failureThreshold: 2, injectProtocol: false, ignoreTools: ['read'] })
  assert.equal(relaxed.sections.length, 0, 'injectProtocol=false 时不注册 section')
  relaxed.toolResult('read', { failed: true, text: 'ENOENT' })
  relaxed.toolResult('read', { failed: true, text: 'ENOENT' })
  assert.equal(relaxed.sections.length, 0, 'ignoreTools 应跳过计数')
  relaxed.toolResult('pwsh', { failed: true, text: 'x' })
  relaxed.toolResult('pwsh', { failed: true, text: 'x' })
  assert.equal(relaxed.sections.length, 1, '非忽略工具仍会触发')
}

// F. shell 的非零退出码算失败（pwsh 工具不设 isError，只在末尾追加标记）
{
  const shell = harness({ failureThreshold: 2, injectProtocol: false })
  shell.toolResult('pwsh', { failed: false, text: '[stderr] boom [exit code: 1]' })
  assert.equal(shell.sections.length, 0, '一次失败还不够')
  shell.toolResult('pwsh', { failed: false, text: '[stderr] boom again [exit code: 2]' })
  assert.equal(shell.sections.length, 1, '两个非零退出码应触发检查点')

  const fine = harness({ failureThreshold: 1, injectProtocol: false })
  fine.toolResult('pwsh', { failed: false, text: 'done [exit code: 0]' })
  assert.equal(fine.sections.length, 0, 'exit code 0 不算失败')
}

// H. 声明 Config 后宿主传的是带 .get() 的引用：读取必须走 get()
{
  const signal = (value) => ({ get: () => value })
  const live = harness({
    enabled: signal(true),
    failureThreshold: signal(2),
    injectProtocol: signal(true),
    injectReminder: signal(true),
    ignoreTools: signal(['read']),
    maxEvidence: signal(1),
  })
  assert.equal(live.sections.length, 1, '引用式配置下协议 section 仍应注册')
  live.toolResult('read', { failed: true, text: 'ENOENT' })
  live.toolResult('read', { failed: true, text: 'ENOENT' })
  assert.equal(live.sections.length, 1, 'ignoreTools 从引用读取')
  live.toolResult('pwsh', { failed: true, text: 'a' })
  live.toolResult('pwsh', { failed: true, text: 'b' })
  assert.equal(live.sections.length, 2, '阈值从引用读取（2 次）')
  assert.equal((live.latest().text.match(/^- /gm) ?? []).length, 1, 'maxEvidence 从引用读取（1 条）')
}

console.log('PASS: 系统提示注入 / 检查点改写 / 撤回 / 证据 / 仅触发一次 / 成功清零 / 忽略名单 / 退出码判定 / 引用式配置')

