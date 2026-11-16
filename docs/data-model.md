# 数据模型

SQLite，文件在 `data/openchat.db`。WAL 模式，`synchronous=NORMAL`，
`foreign_keys=ON`，`busy_timeout=5000`。

表结构版本记在 `meta.schema_version`，现在是 **v2**（v1 的库会自动迁移，测试里有覆盖）。

## conversations

一条会话。现在只有一条 1:1（`id = c-main`）。留着 `dsh_session_id` 是为了 P5 接 DSH 时
把网页会话和 DSH 会话对上。

| 列 | 说明 |
|---|---|
| id | 主键 |
| kind | 只有 `dm` |
| title | 会话标题 |
| dsh_session_id | P5 才填 |
| last_seq | 已发出的最大 seq，发新消息时 +1 |
| created_at / updated_at | 毫秒 |

## messages

| 列 | 说明 |
|---|---|
| id | uuid |
| conv_id | 外键 → conversations |
| seq | 会话内递增，`UNIQUE(conv_id,seq)`，客户端游标就是它 |
| sender | `me` / `fish` |
| kind | `text` / `sticker` / `voice` / `system` / `image` / `video` / `file` |
| text | 正文；语音消息里放转写结果 |
| sticker_id | → stickers.id；表情删了历史消息照样能显示（行还在） |
| attachment_id | → attachments.id；图片/视频/文件消息用它 |
| voice_ms | 语音时长 |
| audio_ref | **现在永远为空**。以后存音频时写对象键/相对路径，不用改表 |
| reply_to | 引用回复，指向上一条 message.id |
| source | `web` / `mock` / `dsh` / `import` |
| client_id | 客户端生成，`UNIQUE`，防重发导致两条一样的 |
| created_at | 毫秒 |

索引：`(conv_id, seq DESC)` 翻历史、`(sticker_id)` 查引用。

## stickers

共享池，上限 100（数 `deleted_at IS NULL` 的行）。

| 列 | 说明 |
|---|---|
| id | uuid |
| sha256 | 文件内容哈希，`UNIQUE`，同一张图只存一份 |
| ext / mime | jpg / png / webp / gif |
| width / height / bytes | 原图尺寸和大小 |
| animated | gif 为 1 |
| file_rel | 相对 `data/` 的路径 |
| thumb_rel | 缩略图路径；gif 是首帧 |
| deleted_at | 软删标记：面板里不显示，文件和数据都留着 |

文件布局：`data/stickers/<哈希前两位>/<sha256>.<ext>`，
缩略图 `data/thumbs/<sha256>.png`。

## attachments

普通附件。跟表情不是一个东西：没有池子、没有软删，上传完就挂在消息上。

| 列 | 说明 |
|---|---|
| id | uuid |
| sha256 | 内容哈希，`UNIQUE`，同一份文件只存一份 |
| kind | `image` / `video` / `file` |
| name | 原始文件名（清洗过），只用来显示 |
| ext / mime | 扩展名和 MIME |
| width / height | 图片才有 |
| bytes | 大小 |
| file_rel | 相对 `data/` 的路径 |
| thumb_rel | 图片缩略图；视频和文件为空 |
| created_at | 毫秒 |

文件布局：`data/files/<哈希前两位>/<sha256>.<ext>`，缩略图 `data/file-thumbs/<sha256>.png`。

## auth_sessions

多设备登录，一台设备一行。

| 列 | 说明 |
|---|---|
| token_hash | sha256(随机 token)，**不存明文** |
| created_at / last_seen_at / expires_at | 毫秒 |
| ua / ip | 留个线索，方便自己看是哪台 |

## calls

预留给语音/视频通话。现在只有 `unsupported` 这一种状态，表先建好。

## meta

键值对：`schema_version`，以后还会有各种游标。
