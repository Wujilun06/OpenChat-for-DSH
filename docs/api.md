# 接口与事件

Base 路径 `/api`。除了上传/下载，都是 JSON。错误统一是
`{ "ok": false, "code": "…", "message": "…" }`，`code` 是给代码看的，`message` 是给人看的。

## P0 已有

| 方法 | 路径 | 要什么 | 给什么 |
|---|---|---|---|
| GET | `/api/health` | — | `{ok,version,node,db,asr,time}` |
| POST | `/api/auth/login` | `{password}` | `{ok,expiresAt}` + Set-Cookie |
| POST | `/api/auth/logout` | — | `{ok:true}` |
| GET | `/api/auth/me` | cookie | `{ok,peer,conversation,expiresAt}` |

`/api/health` 不需要登录，其余三个里 `login` 不要登录态，`logout` / `me` 要。

状态码：`400` 参数不对、`401` 没登录/密码错、`404` 没这个接口、
`429` 试太多次、`503` 前端还没构建。

Cookie 名 `oc_session`：HttpOnly、SameSite=Lax、https 下带 Secure、有效期跟 `session.days` 走。

## P1–P4 规划（先定名字，实现时按这个来）

| 方法 | 路径 | 干什么 |
|---|---|---|
| GET | `/api/conversation` | 这一间会话的信息 |
| GET | `/api/messages?before=&limit=` | 向上翻历史 |
| GET | `/api/messages?since=` | 断线补齐 |
| POST | `/api/messages` | 发文字/表情 |
| POST | `/api/messages/voice` | 传音频 → 转写 → 建语音消息 |
| POST | `/api/typing` | 告诉对面在打字 |
| GET | `/api/stickers` | 表情列表（带缩略图地址） |
| POST | `/api/stickers` | 上传表情 |
| DELETE | `/api/stickers/:id` | 软删 |
| GET | `/api/stickers/:id/thumb` | 缩略图 |
| GET | `/api/stickers/:id/file` | 原图 |
| GET | `/api/calls/status` | 通话能力状态 |
| POST | `/api/calls` | 预留，现在回 501 |
| GET | `/api/stream?since=` | SSE |

## SSE 事件

连接：`GET /api/stream?since=<最后一条 seq>`。服务端先发一条 `hello`，
再按 seq 顺序把 `since` 之后的 `message.created` 补给你，然后转实时。
每 25 秒发一次 `ping` 防止中间的反代把连接掐了。

| 事件名 | 什么时候发 | 载荷 | 谁的职责 |
|---|---|---|---|
| `hello` | 刚连上 | `{convId,lastSeq,serverTime}` | 客户端拿它跟本地对账 |
| `message.created` | 新消息落库之后 | 完整 `MessageInfo` | 所有在线设备 |
| `message.updated` | 消息内容变了（比如转写补完、发送失败） | `{id,changes}` | 只给变化，省流量 |
| `message.deleted` | 撤回（先留接口） | `{id}` | 客户端把它从列表摘掉 |
| `typing.changed` | 对方开始/停止打字 | `{who,on}` | `who` 是 `'fish'` 或 `'me'` |
| `call.state` | 通话状态变 | `CallInfo` | P4 之前只会是 `unsupported` |
| `ping` | 每 25 秒 | `{t}` | 客户端不用回 |

**改事件名的时候**：`packages/shared/src/index.ts` 里的 `StreamEvent`、这张表、
和实际发事件的地方，三处一起改。少一处就会静默不显示。

## 消息对象

```ts
interface MessageInfo {
  id: string
  convId: string
  seq: number              // 会话内递增，客户端游标
  sender: 'me' | 'fish'
  kind: 'text' | 'sticker' | 'voice' | 'system'
  text: string | null      // 正文 / 语音转写
  sticker: StickerInfo | null
  voiceMs: number | null   // 语音时长，气泡上显示秒数
  replyTo: MessageRef | null
  source: 'web' | 'mock' | 'dsh' | 'import'
  createdAt: number        // 毫秒时间戳
}
```

## 限制（前后端都校验）

| 项 | 值 |
|---|---|
| 表情单文件 | 5 MB |
| 表情共享池 | 100 个 |
| 语音 | 60 秒，最长 |
| 文字 | 4000 字 |
| 登录失败 | 10 分钟 5 次 → 锁 15 分钟 |
