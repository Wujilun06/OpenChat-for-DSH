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
{ "clientId": "客户端生成的 uuid", "kind": "sticker", "stickerId": "表情 id" }
{ "clientId": "客户端生成的 uuid", "kind": "image", "attachmentId": "附件 id" }
```

- `clientId` 必填。同一条重发会拿回原来那条，`created: false`，不会变两条。
- `kind` 认 `text` / `sticker` / `image` / `video` / `file`；别的回 `kind_not_ready`。
- 文字去掉首尾空白后为空 → `400 empty_message`；超过 4000 字 → `400 too_long`。
- 表情必须还在面板里（没删）→ 否则 `400 bad_sticker`。
- 图片/视频/文件必须带 `attachmentId`，而且附件类型要对得上 → 否则
  `400 attachment_required` / `bad_attachment` / `attachment_kind_mismatch`。
- `replyTo` 指向不存在的消息 → `400 bad_reply_to`。

### 合并窗口

一条用户消息落库之后，服务端等 2 秒（`mock.mergeWindowMs`）再开始回：
这 2 秒内连发的几句会算成一轮。假鱼正在回的时候你再发，排在下一轮。

### POST /api/messages/voice

`multipart/form-data`，字段 `file` 放录音；query 带 `clientId`，可选 `replyTo`。

流程：临时落盘 → ffmpeg 转 16k 单声道 wav → SenseVoice 转写 → **删掉临时音频** →
落一条 `kind: 'voice'`。响应里的 `message.text` 是转写结果，`voiceMs` 是时长。

错误：`asr_not_ready`(503，还没装转写)、`audio_too_large`(413)、`bad_audio`(400)、
`voice_too_long`(400)、`asr_empty`(422，没听清)、`asr_failed`(500)。

## 表情（P2 已实现）

| 方法 | 路径 | 干什么 |
|---|---|---|
| GET | `/api/stickers` | 面板列表（只有没删的），带 `maxCount` |
| POST | `/api/stickers` | multipart 上传，字段名 `file` |
| DELETE | `/api/stickers/:id` | 软删 |
| GET | `/api/stickers/:id/thumb` | 缩略图（gif 是首帧 png） |
| GET | `/api/stickers/:id/file` | 原图（gif 会动） |

规则：

- 只收 jpg / png / webp / gif，单张 5 MB，共享池 100 个（数没删的）。
- 按内容 sha256 去重：同一张再传一次直接给原来那条；软删过的会**复活**。
- 软删只是从面板里拿掉，文件和记录都留着，历史消息照常显示。
- 两个取图接口都带 `cache-control: public, max-age=31536000, immutable`，
  所以客户端可以放心缓存（url 里带 id，内容不会变）。
- 缩略图最长边 240px；gif 的首帧转成 png。

错误码：`file_too_large`(413)、`bad_image`(400)、`unsupported_format`(400)、
`sticker_limit`(409)、`sticker_required` / `bad_sticker`(400)、`sticker_not_found`(404)。

发一条表情消息就是把 `kind` 换成 `sticker`、带上 `stickerId`（见上面「消息」）。

## 附件：图片 / 视频 / 文件（P2.5 已实现）

| 方法 | 路径 | 干什么 |
|---|---|---|
| POST | `/api/attachments` | multipart 上传，字段名 `file` |
| GET | `/api/attachments/:id/thumb` | 图片缩略图 / 视频首帧（png，320px 内） |
| GET | `/api/attachments/:id/file` | 原文件，支持 `Range` |

规则：

- 按 `Content-Type` 分类：`image/*` → 图片（用 sharp 验一遍）、`video/*` → 视频、其余 → 文件。
- 上限（可在 `config.attachment` 改）：图片 10 MB、视频 50 MB、文件 50 MB。
- 同一份内容只存一次（sha256 去重）。
- 视频的首帧用 `ffmpeg` 抽（`config.media.ffmpeg`），宽高用 `ffprobe` 读；
  工具不在或者抽不出来就不给缩略图，前端显示占位方块 + 播放角标。
- 老视频补首帧：同一个文件再传一次会顺手补上（不用重发消息）。
- `file` 响应带 `Range` 支持（206 + `Content-Range`），Safari 播视频要靠它。
- 图片/视频用 `Content-Disposition: inline`，普通文件用 `attachment`（点了就下载）。
- 附件跟表情是两回事：附件进 `attachments` 表，发完就挂在消息上；表情进共享池。

错误码：`file_too_large`(413)、`bad_image`(400)、`unsupported_image`(400)、
`attachment_not_found`(404)、`file_missing`(404)、`thumb_missing`(404)。

## 通话（还没做）

| 方法 | 路径 | 状态 |
|---|---|---|
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
| 图片 | 10 MB |
| 视频 | 50 MB |
| 文件 | 50 MB |
| 语音 | 60 秒，最长 |
| 文字 | 4000 字 |
| 登录失败 | 10 分钟 5 次 → 锁 15 分钟 |
| SSE 一次补 | 5 页 × 200 条 |
