# 接 DSH（P5）

OpenChat 的聊天对象从「假鱼回声」换成 DSH 里真实的那间会话。

## 怎么接的

```
网页 ──HTTP/SSE──> OpenChat 后端 ──HTTP/SSE──> dsh-openchat-bridge（DSH 插件）──> 会话
```

- **桥**（`dsh-bridge/`，宿主侧薄插件）：在本机 `127.0.0.1:8788` 起一个小服务，只做四件事：
  读历史、投一条文字、推助手的新消息、列会话。它调用 DSH 的 `ctx.sessionController.prompt / create`
  和 `ctx.on('session/event')`，不碰 QQ，也没有客户端半边。
- **OpenChat 后端**：启动时从桥拉最近 `dsh.historyLimit` 条历史（按消息 id 去重写库），
  之后挂一条 SSE 收助手消息；网页发的话按 `dsh.mergeWindowMs` 合并后送进会话。
- 开着 DSH 时假鱼回声自动关掉。

## 配置

桥的配置在 `~/.dsh/openchat-bridge.json`（插件第一次启动会生成）：

```json
{
  "port": 8788,
  "token": "随机串",
  "session": "bili-whale",
  "cwd": "C:\\Users\\LECOO\\.dsh\\whale-work"
}
```

- `session`：接哪间会话。`bili-whale` 是那条养鱼的长会话。
- `cwd`：会话没开时要用的工作目录。
- `token`：OpenChat 用同一个（`x-openchat-token` 头）。

OpenChat 的 `config.json` 里：

```json
"dsh": {
  "enabled": true,
  "baseUrl": "http://127.0.0.1:8788",
  "token": "",
  "session": "",
  "historyLimit": 200,
  "mergeWindowMs": 2000
}
```

`token` / `session` 留空就自动读桥那个文件，两边不会写岔。

## 装/升级

```powershell
dsh plugin --profile desktop add "file:D:\DSH\OpenChat\dsh-bridge"
```

装完**重启一次 DSH**（宿主侧插件不会热加载）。重启后 `http://127.0.0.1:8788/health`
应该能返回 `{"ok":true,...}`。

## 临时断开 / 重新接上

现在 QQ 还在用，OpenChat 只是验证过就断开：

- 断开：`config.json` 里 `dsh.enabled` 改 `false`（`mock.enabled` 也关掉，不然假鱼会插话），重启 OpenChat。
  桥和插件还留在 DSH 里，只是没人用了。
- 重新接：`dsh.enabled` 改回 `true`，重启 OpenChat；**先把目标会话在 DSH 里点开**（没开的会话桥塞不进去，会回 `session_not_open`）。
- 桥的配置在 `~/.dsh/openchat-bridge.json`，改完要重启 DSH 才读。

## 已知边界

- 只同步**助手说的话**（以及导入的历史）。你在 DSH 窗口里亲手打的字不会实时出现在网页里，
  下次启动导历史时才进来——避免和网页自己发的那条重复。
- **图片/表情**会送进 DSH：以 base64 交给宿主的 `attachments.admitPromptContent` 转成附件，
  再进提示词（跟 qq-bridge 一个路子）；单张超过 5MB 就改给本地路径。
- **视频/文件**作为一条带本地路径的文字送进去（DSH 能读文件，但不会“看”视频）。
- 语音消息送的是转写文字。
- 会话必须在 DSH 里能开：桥会先试 `agents.get`，再 `sessionController.create`；
  两边都失败就回 `session_not_open`。
- 桥只监听 `127.0.0.1`，外面连不到；要暴露请自己加反代。
