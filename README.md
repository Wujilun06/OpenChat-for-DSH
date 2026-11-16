# OpenChat

一个自己的网页聊天，最后要能塞进一个更大的面板里。做一个的理由很实在：
QQ 那条线（NapCat / OneBot）哪天坏了，还能找得到鱼。

现在做到 **P1**：登录、SQLite、PWA 壳、文字聊天（左右气泡、引用回复、
正在输入、时间戳三档、断线补齐、连发合并）。
回答现在是 `config.mock` 里的假鱼回声；接上 DSH 之后关掉它就行。

## 快速开始

```bash
npm install
cp config.example.json config.json   # 然后把 password 改掉
npm run dev                          # server :8787 + vite :5173
```

打开 http://127.0.0.1:5173 。开发时 vite 把 `/api` 转到 8787。

生产：

```bash
npm run build
npm start            # 只开 :8787，前端从 apps/web/dist 出
```

## 配置

密码、端口、对方昵称头像都在 `config.json`，这个文件**不进 git**（`.gitignore` 里）。
字段含义见 `config.example.json`。

`mock` 那几项是假鱼回声：`enabled` 关掉就没人回话了；
`mergeWindowMs` 是连发合并窗口（默认 2000）；`typingMs` 是「正在输入」多久后出字。

`dataDir` 默认是仓库下的 `data/`，里面会有 `openchat.db`、`stickers/`、`thumbs/`。

## 目录

```
apps/server      Fastify + TS + node:sqlite
apps/web         React + Vite + TS + PWA
packages/shared  前后端共用的接口类型
docs/            需求、数据模型、接口与事件说明、里程碑
scripts/         图标生成、开机自启
```

## 接口与事件

全部写在 [docs/api.md](docs/api.md)。事件名、每个名字的作用、载荷字段都在那，
改事件名要同时改那张表和 `packages/shared/src/index.ts`。

## 安全

- 密码明文放 `config.json`，所以这个文件不能提交、不能截图发人。
- 登录失败 5 次锁 15 分钟（同一个 IP）。
- 会话 cookie 是 HttpOnly + SameSite=Lax，https 下自动带 Secure。
- 要走公网（Tailscale Funnel）之前，**必须先把 `config.json` 里那个临时密码改掉**。

## 里程碑

P0 骨架 ✅ → P1 文字聊天 ✅ → P2 表情 → P3 语音（转写，不存音频）→ P4 通话占位 → P5 接 DSH。
细节和验收标准在 [docs/milestones.md](docs/milestones.md)。
