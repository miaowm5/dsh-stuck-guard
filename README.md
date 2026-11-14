# dsh-stuck-guard

卡住就停：连续工具调用失败达到阈值时，把一份「停机检查点」注入系统提示——附上失败调用与报错首行——让 agent 停下来汇报并问人，而不是继续换第四种办法。

Stops the agent instead of letting it keep trying workarounds: after N consecutive tool failures it injects a checkpoint into the system prompt, quoting the failing calls.

## 它做什么

两件事都注册在**系统提示**上（`ctx.systemPrompt.section(...)`），每次请求都带着，不依赖 step 边界或 inbox 投递：

1. **升级协议**（`dsh-stuck-guard:protocol`）：什么时候该停、什么算一次尝试、停下时该发什么、硬红线。规则文本内嵌在 `index.js` 里，插件装到哪台机器，规则就跟到哪台机器。
2. **卡住检查点**（`dsh-stuck-guard:checkpoint`）：监听 `tool/result`，连续失败到阈值（默认 3 次）时注册，把证据摆进提示；任一次成功调用或新的用户消息到达时，调用 section 返回的 disposer 撤掉。

失败判定只看结构化信号：`tool/result` 的 `error` 字段、`message.isError`、以及结果文本末尾的 `[exit code: N]`（shell 工具对非零退出码只打这个标记，不设 isError——这是最常见的失败形态）。

## 检查点长什么样

```
[卡住检查点 · dsh-stuck-guard]
最近连续 3 次工具调用失败，且看起来是同一类失败。按「升级协议」现在该停，不是再换一招。
插件抓到的证据（最近几条，可直接写进汇报）：
- pwsh | [stderr] Get-Item : 找不到路径"C:\x"，因为该路径不存在。…
现在必须做：结束本回合，用不超过 15 行汇报——目标 / 已试方法表 / 已排除的假设 / 剩余可能 /
你的判断 / A、B、C 三个选项，并直接问「你有方案吗？要按哪个走？」。
```

## 为什么是提醒，不是硬阻塞

「连续失败 3 次」是确定性信号，「这 3 次是不是在同一个坑里」不是。插件负责在正确的时间点把证据摆出来；是否属于同一个问题、该不该停，交给模型结合证据判断。硬阻塞会误伤合法的重试与探索式调试（TDD、逐步收敛的搜索、需要多轮试错的签名还原）。

## 要求

- DSH 需要提供 `ctx.systemPrompt` 服务。插件通过 `export const inject = ['systemPrompt']` 声明依赖，缺少该服务的 profile 里不会激活。0.1.0 在桌面版验证通过。
- 不需要网络、不需要凭据，不读写项目文件。

## 安装

在插件管理器里填安装规格：

```
github:miaowm5/dsh-stuck-guard#v0.1.0
```

也可以装本地目录（填绝对路径），或者发布到 npm 后直接用包名。装完如果插件列表里没出现，重启一次 DSH。

## 配置

插件导出了 `Config`，所以 **Settings 里会出现配置表单**——但表单只列 `.volatile()` 字段（改动原地生效，不重载插件）：

| 字段 | 默认 | Settings 表单 | 说明 |
|---|---|---|---|
| `failureThreshold` | 3 | ✅ | 连续失败几次触发检查点 |
| `injectReminder` | true | ✅ | 是否注册检查点 |
| `ignoreTools` | `[]` | ✅ | 不参与计数的工具名 |
| `maxEvidence` | 3 | ✅ | 检查点里带几条证据 |
| `injectProtocol` | true | ❌ | 是否放协议正文；改动需重载插件 |
| `maxSessions` | 200 | ❌ | 会话状态上限 |
| `enabled` | true | ❌ | 关掉后不注册任何 section |

非 volatile 字段和 `cordis.patch.yml` 覆盖仍然有效：

```yaml
- id: dsh-stuck-guard
  name: dsh-stuck-guard
  config:
    injectProtocol: false
```

改完在插件设置里关掉再打开即可生效（live 重载，不必重启）。表单只写 volatile 字段、不写普通字段，所以两者可以并存。

## 自测

```powershell
node test/simulate.mjs
```

覆盖：协议 section 注册、阈值触发检查点、证据内容、只触发一次、成功/用户消息撤回、忽略名单、退出码判定（`[exit code: 1]` 算失败、`[exit code: 0]` 不算）。不依赖 DSH 运行时。`test/` 不在 `files` 里，不随包发布。

## 诊断与副作用

每次加载、注册 section、触发阈值、报错都会写一行 JSON 到 `<DSH_HOME>/dsh-stuck-guard.log`（默认 `~/.dsh/dsh-stuck-guard.log`）：

- `module-loaded` / `apply`：文件真的被加载、配置真的生效
- `section`：section 注册成功（`checkpoint: true/false` 表示加/撤）
- `threshold`：失败计数到阈值
- `error`：哪一步失败、为什么

每个进程最多写 200 行；文件超过 512KB 时轮转一次为 `dsh-stuck-guard.log.1`。除这个日志外没有其它磁盘副作用。

```powershell
Get-Content "$env:USERPROFILE\.dsh\dsh-stuck-guard.log" -Tail 20
```

## 卸载

在插件管理器里移除该 bundle。手工装进 profile 的，删掉 `package.json` 里的依赖行、`dsh.profile.bundles` 里的名字和 `node_modules` 下的链接，然后重启。

## 已知限制

- 只按「连续失败次数」计数；三次毫不相关的失败也会触发一次检查点（证据就在旁边，模型能看出不相关，成本是一段文字）。
- 检查点是软约束：模型理论上仍可能忽略它继续试。要硬拦截，得在 `agent/pre-step` 里返回 `{ kind: 'reject' }`，代价是可能误伤合法调试。
- `section` 同名只能注册一次，所以检查点用独立名字并靠 disposer 撤销；如果宿主版本不返回 disposer，检查点会一直留到插件重载（日志里 `disposable: false`）。
- 协议正文常驻系统提示，约 1.4KB；`injectProtocol: false` 可关。
