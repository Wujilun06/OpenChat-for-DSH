# 接口与事件

Base 路径 `/api`。除了上传/下载，都是 JSON。错误统一是
`{ "ok": false, "code": "…", "message": "…" }`，`code` 是给代码看的，`message` 是给人看的。

状态码：`400` 参数不对、`401` 没登录、`404` 没这个接口、
`429` 试太多次、`503` 前端还没构建。

## 认证

| 方法 | 路径 | 要什么 | 给什么 |
|---|---|---|---|
| POST | `/api/auth/login` | `{password}` | `{ok,expiresAt}` + Set-Cookie |
| POST | `/api/auth/logout` | — | `{ok:true}` |
| GET | `/api/auth/me` | cookie | `{ok,peer,conversation,expiresAt}` |
| GET | `/api/health` | — | `{ok,version,node,db,asr,time}`（不用登录） |

Cookie 名 `oc_session`：HttpOnly、SameSite=Lax、https 下带 Secure、
有效期跟 `session.days` 走。

## 消息（P1 已实现）

| 方法 | 路径 | 干什么 |
|---|---|---|
| GET | `/api/conversation` | 这一间会话的信息 |
| GET | `/api/messages?limit=&before=` | 往上翻历史，`before` 是不包含的那个 seq |
| GET | `/api/messages?limit=&since=` | 断线补齐，只要 `seq > since` |
| POST | `/api/messages` | 发一条文字 |
| POST | `/api/typing` | 告诉服务器自己在打字 |
| GET | `/api/stream?since=` | SSE |

### POST /api/messages

```json
{ "clientId": "客户端生成的 uuid", "kind": "text", "text": "在吗", "replyTo": "被引用消息的 id" }
```

- `clientId` 必填。同一条重发会拿回原来那条，`created: false`，不会变两条。
- `kind` 现在只认 `text`；`sticker`/`voice` 回了 `kind_not_ready`。
- 文字去掉首尾空白后为空 → `400 empty_message`；超过 4000 字 → `400 too_long`。
- `replyTo` 指向不存在的消息 → `400 bad_reply_to`。

### 合并窗口

一条用户消息落库之后，服务端等 2 秒（`mock.mergeWindowMs`）再开始回：
这 2 秒内连发的几句会算成一轮。假鱼正在回的时候你再发，排在下一轮。

## 表情 / 通话（还没做）

| 方法 | 路径 | 状态 |
|---|---|---|
| GET | `/api/stickers` | P2 |
| POST | `/api/stickers` | P2 |
| DELETE | `/api/stickers/:id` | P2 |
| GET | `/api/stickers/:id/thumb` | P2 |
| GET | `/api/stickers/:id/file` | P2 |
| GET | `/api/calls/status` | P4 |
| POST | `/api/calls` | P4，先回 501 |

## SSE 事件

连接：`GET /api/stream?since=<最后一条 seq>`。服务端先发一条 `hello`，
再把 `since` 之后的消息补一遍（最多 5 页 × 200 条），然后转实时。
没有消息的时候每 25 秒发一次 `ping`，防止中间的反代把连接掐了。

| 事件名 | 什么时候发 | 载荷 | 谁的职责 |
|---|---|---|---|
| `hello` | 刚连上 | `{convId,lastSeq,serverTime}` | 客户端拿它跟本地对账，落后了就走 `since` 补 |
| `message.created` | 新消息落库之后 | 完整 `MessageInfo` | 所有在线设备；按 id 去重 |
| `message.updated` | 消息内容变了 | `{id,changes}` | 只给变化，省流量 |
| `message.deleted` | 撤回（先留接口） | `{id}` | 客户端把它从列表摘掉 |
| `typing.changed` | 对方开始/停止打字 | `{who,on}` | `who` 是 `'fish'` 或 `'me'` |
| `call.state` | 通话状态变（P4） | `CallInfo` | 现在不会发 |
| `ping` | 每 25 秒 | `{t}` | 客户端不用回 |

**改事件名的时候**：`packages/shared/src/index.ts` 里的 `StreamEvent`、这张表、
和实际发事件的地方（`apps/server/src/app.ts` / `services/mockFish.ts`），四处一起改。
少一处就会静默不显示。

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

`source` 里 `mock` 是 P1 的假鱼回声，接上 DSH 以后会变成 `dsh`。

## 限制（前后端都校验）

| 项 | 值 |
|---|---|
| 表情单文件 | 5 MB |
| 表情共享池 | 100 个 |
| 语音 | 60 秒，最长 |
| 文字 | 4000 字 |
| 登录失败 | 10 分钟 5 次 → 锁 15 分钟 |
| SSE 一次补 | 5 页 × 200 条 |
