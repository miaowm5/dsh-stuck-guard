# dsh-stuck-guard

卡住就停。把「连续换招但没结果时先停下来问人」变成随插件走的机制，而不是某台机器上的一个 Markdown 文件。

## 它做两件事

两件事都注册在**系统提示**上（`ctx.systemPrompt.section(...)`），每次请求都带着，不依赖 step 边界或 inbox 投递：

1. **升级协议**：`dsh-stuck-guard:protocol` section。内容是触发条件、什么算一次尝试、停下时说什么、硬红线。规则文本内嵌在 `index.js` 里，插件装到哪台机器，规则就跟到哪台机器。
2. **卡住检查点**：监听 `tool/result`，连续失败到阈值（默认 3 次）时，再注册一个 `dsh-stuck-guard:checkpoint` section，把插件抓到的证据（工具名 + 报错首行）摆进提示。任意一次成功调用或新的用户消息到达时，调用 section 返回的 disposer 把它撤掉。

判定只看结构化信号：`tool/result` 的 `error` 字段、`message.isError`、以及结果文本末尾的 `[exit code: N]`（pwsh 工具对非零退出码只打这个标记，不设 isError——这是最常见的失败形态）。

## 为什么是提醒，不是硬阻塞

「连续失败 3 次」是确定性信号，「这 3 次是不是在同一个坑里」不是。插件负责在正确的时间点把证据摆出来；是否属于同一个问题、该不该停，交给模型判断。硬阻塞会误伤合法的重试与探索式调试（TDD、逐步收敛的搜索、需要多轮试错的签名还原）。

## 安装

本机（`C:\Users\admin\.dsh\profiles\desktop`）已安装并验证生效。

另一台设备：

```powershell
# 1. 把整个 stuck-guard 目录拷过去（U 盘、网盘、git 都行）
# 2. 在目标机器的插件目录里执行：
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 3. 重启 DSH
```

`install.ps1` 会先备份 profile 的 `package.json`，再写依赖、写 bundles、建 `node_modules` 链接。多 profile 时用 `-ProfileDir` 指定。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖，改完在插件设置里关掉再打开（live 重载，不必重启）：

```yaml
- id: dsh-stuck-guard
  name: dsh-stuck-guard
  config:
    failureThreshold: 3   # 连续失败几次触发检查点
    injectProtocol: true  # 是否把协议正文放进系统提示
    injectReminder: true  # 是否注册检查点
    ignoreTools: [read]   # 不参与计数的工具
    maxEvidence: 3        # 检查点里带几条证据
```

## 自测

```powershell
node test/simulate.mjs
```

覆盖：协议 section 注册、阈值触发检查点、证据内容、只触发一次、成功/用户消息撤回、忽略名单、退出码判定（`[exit code: 1]` 算失败、`[exit code: 0]` 不算）。不依赖 DSH 运行时。

## 诊断

每次加载、注册 section、触发阈值、报错都会写一行 JSON 到 `<DSH_HOME>/dsh-stuck-guard.log`（默认 `~/.dsh/dsh-stuck-guard.log`，每进程上限 200 行）：

```powershell
Get-Content "$env:USERPROFILE\.dsh\dsh-stuck-guard.log" -Tail 20
```

- `module-loaded` / `apply`：文件真的被加载、配置真的生效
- `section`：section 注册成功（`checkpoint: true/false` 表示检查点的加/撤，`disposable` 表示能否撤销）
- `threshold`：失败计数到阈值
- `error`：哪一步失败了、为什么

## 卸载

```powershell
.\uninstall.ps1
```

删依赖、删 bundles 行、删链接，然后重启 DSH。`package.json.bak-*` 备份保留，可手动回滚。

## 从文件迁移过来时的兜底

`protocol-fallback.md` 是原先 `~/.dsh/AGENTS.md` 的内容。如果插件被禁用或加载失败，把它拷回去即可恢复「文件版」规则：

```powershell
Copy-Item .\protocol-fallback.md "$env:USERPROFILE\.dsh\AGENTS.md"
```

## 已知限制

- 只按「连续失败次数」计数；三次毫不相关的失败也会触发一次检查点（证据就在旁边，模型能看出不相关，成本是一段文字）。
- 检查点是软约束：模型理论上仍可能忽略它继续试。要硬拦截，得在 `agent/pre-step` 里返回 `{ kind: 'reject' }`，代价是可能误伤合法调试。
- `section` 同名只能注册一次，所以检查点用独立名字并靠 disposer 撤销；如果宿主版本不返回 disposer，检查点会一直留到插件重载（日志里 `disposable: false` 会提示）。
- 协议正文常驻系统提示，约 1.4KB；`injectProtocol: false` 可关。
