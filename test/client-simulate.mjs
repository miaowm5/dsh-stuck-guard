/**
 * 离线自测：不启动 DSH、不开浏览器，用最小假 React / 假 ctx / 假 settings Remote 跑一遍 client.js。
 *
 * 覆盖：模块 id 与注入声明、槽位注册（plugins.bundle.config / key=包名）、
 * 命名空间识别的四种兜底、草稿归一化、只提交改动字段、compare-and-set 的 revision、
 * 保存失败与只读、schema 只暴露部分字段时的降级。
 *
 * 用法：node test/client-simulate.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let loaded
const fakeWindow = { __ModuleLoader__: { load(config) { loaded = config } } }
// client.js 第一行就是 window.__ModuleLoader__.load(...)，用最小 window 执行它。
new Function('window', source)(fakeWindow)

assert.ok(loaded, 'client.js 必须调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-stuck-guard', '模块 id 必须是包名（宿主按包名把浏览器半截挂到该行）')
assert.equal(typeof loaded.factory, 'function', 'factory 必须存在')

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
}

const mod = loaded.factory((name) => {
  assert.equal(name, 'react', `浏览器半截只能 require react，却 require 了 ${name}`)
  return fakeReact
})

assert.deepEqual(mod.inject.slice().sort(), ['locale', 'remote', 'remote.settings', 'slots'].sort(), '注入声明应只含这四个服务')
assert.equal(typeof mod.apply, 'function')

const test = mod.__test

/**
 * 假 Client 宿主。
 * @param {any} describeResult - settings/describe 的答复（`{ ok, value }` 或裸值）。
 * @param {(ns: string, patch: object, revision?: number) => Promise<any>} [update]
 */
function harness(describeResult, update) {
  const registrations = []
  const injections = []
  const effects = []
  const remote = {
    settings: {
      describe: async () => describeResult,
      update: async (...args) => (update === undefined ? { ok: true, value: {} } : update(...args)),
    },
  }
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject(key, callback) {
        injections.push(key)
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return { dispose() {} }
      },
    },
    remote,
    effect(fn, label) {
      effects.push(label)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { warn() {} },
  }
  mod.apply(ctx)
  return { ctx, remote, registrations, injections, effects }
}

const okDescribe = () => ({
  ok: true,
  value: {
    writable: true,
    namespaces: [{
      ns: 'include:dsh-stuck-guard',
      revision: 7,
      schema: {
        type: 'object',
        properties: {
          failureThreshold: {},
          maxEvidence: {},
          injectReminder: {},
          ignoreTools: {},
        },
      },
      value: {
        failureThreshold: 3,
        maxEvidence: 3,
        injectReminder: true,
        ignoreTools: [],
      },
    }],
  },
})

// A. 注册：只挂 plugins.bundle.config，key 是包名
{
  const host = harness(okDescribe())
  assert.deepEqual(host.injections, ['plugins.bundle.config'], '应注册到 bundle.config 槽位')
  assert.equal(host.registrations.length, 1)
  assert.equal(host.registrations[0].options.name, 'plugins.bundle.config')
  assert.equal(host.registrations[0].options.key, 'dsh-stuck-guard')
  assert.equal(host.registrations[0].options.locale, 'dsh-stuck-guard')
  assert.ok(host.effects.includes('dsh-stuck-guard: dictionaries'))
  assert.ok(host.effects.includes('dsh-stuck-guard: config styles'))
}

// B. describe -> 草稿
{
  const host = harness(okDescribe())
  await test.refresh(host.remote)
  assert.equal(test.store.phase, 'ready')
  assert.equal(test.store.ns, 'include:dsh-stuck-guard')
  assert.equal(test.store.revision, 7)
  assert.equal(test.store.writable, true)
  assert.deepEqual(test.store.fields, ['failureThreshold', 'maxEvidence', 'injectReminder', 'ignoreTools'])
  assert.deepEqual(test.store.draft, {
    failureThreshold: '3',
    maxEvidence: '3',
    injectReminder: true,
    ignoreTools: '',
  })
}

// C. 只提交改动字段，并带上 revision
{
  const calls = []
  const host = harness(okDescribe(), async (...args) => {
    calls.push(args)
    return { ok: true, value: {} }
  })
  await test.refresh(host.remote)
  test.store.draft.failureThreshold = '2'
  await test.save(host.remote)
  assert.equal(calls.length, 1, '应只发一次 update')
  assert.equal(calls[0][0], 'include:dsh-stuck-guard', 'update 应带命名空间')
  assert.deepEqual(calls[0][1], { failureThreshold: 2 }, '只应提交改动的字段')
  assert.equal(calls[0][2], 7, 'update 应带 compare-and-set 的 revision')
  assert.equal(test.store.saved, true)
}

// D. 数字非法：不提交，界面拿到 invalid
{
  const calls = []
  const host = harness(okDescribe(), async (...args) => {
    calls.push(args)
    return { ok: true, value: {} }
  })
  await test.refresh(host.remote)
  test.store.draft.failureThreshold = '0'
  await test.save(host.remote)
  assert.equal(calls.length, 0, '非法输入不应发 update')
  assert.equal(test.store.writeError, 'invalid')
  test.store.draft.failureThreshold = 'abc'
  await test.save(host.remote)
  assert.equal(calls.length, 0)
}

// E. 列表：去空行、去重、保持顺序
{
  assert.deepEqual(test.normalizeList('read\n\n  read  \npwsh\n'), ['read', 'pwsh'])
  assert.deepEqual(test.normalizeList(['a', 'a', 'b']), ['a', 'b'])
}

// F. 保存被拒：原因保留、revision 重读
{
  const host = harness(okDescribe(), async () => {
    throw new Error('settings revision is stale')
  })
  await test.refresh(host.remote)
  test.store.draft.maxEvidence = '5'
  await test.save(host.remote)
  assert.equal(test.store.writeError, 'failed')
  assert.match(test.store.writeDetail, /stale/)
  assert.equal(test.store.phase, 'ready', '拒绝后应重新读回状态')
}

// G. schema 只投影部分字段：其余字段不显示、也不提交
{
  const partial = () => ({
    ok: true,
    value: {
      writable: true,
      namespaces: [{
        ns: 'dsh-stuck-guard',
        revision: 1,
        schema: { type: 'object', properties: { failureThreshold: {}, maxEvidence: {} } },
        value: { failureThreshold: 3, maxEvidence: 3 },
      }],
    },
  })
  const calls = []
  const host = harness(partial(), async (...args) => {
    calls.push(args)
    return { ok: true, value: {} }
  })
  await test.refresh(host.remote)
  assert.deepEqual(test.store.fields, ['failureThreshold', 'maxEvidence'])
  test.store.draft.ignoreTools = 'read'
  await test.save(host.remote)
  assert.equal(calls.length, 0, '未显示字段的改动不应提交（它们不是 volatile）')
}

// H. 命名空间识别：精确 id / 后缀 / 值形态 / schema 形态
{
  const byId = { ns: 'dsh-stuck-guard', value: {} }
  const bySuffix = { ns: 'include:dsh-stuck-guard', value: {} }
  const byValue = { ns: 'whatever', value: { failureThreshold: 5 } }
  const bySchema = { ns: 'another', schema: { anyOf: [{ properties: { maxEvidence: {} } }] } }
  assert.equal(test.pickNamespace([{ ns: 'other' }, bySuffix]), bySuffix)
  assert.equal(test.pickNamespace([{ ns: 'other' }, byId]), byId)
  assert.equal(test.pickNamespace([{ ns: 'other' }, byValue]), byValue)
  assert.equal(test.pickNamespace([{ ns: 'other' }, bySchema]), bySchema)
  assert.equal(test.pickNamespace([{ ns: 'other', value: {} }]), undefined, '无匹配时应返回 undefined，不能按位置猜')
  assert.equal(test.pickNamespace(undefined), undefined)
}

// I. Remote 信封解包
{
  assert.equal(test.unwrap({ ok: true, value: 41 }), 41)
  assert.equal(test.unwrap(41), 41, '裸值（服务桩）应原样返回')
  assert.throws(() => test.unwrap({ ok: false, error: { message: 'refused' } }), /refused/)
}

console.log('PASS: client 模块 id / 槽位注册 / 命名空间识别 / 草稿归一化 / 改动字段提交 / revision / 无效输入 / 保存失败 / 部分字段降级 / 信封解包')
