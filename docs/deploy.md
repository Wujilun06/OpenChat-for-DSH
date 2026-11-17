# 上线（P4.5）

目标：手机在外网也能打开 OpenChat，并且能「添加到主屏幕」当 App 用。

## 前置事实

- 这台机器在校园网里，**没有公网 IPv4 / IPv6**（只有 `fc01::` 私有 IPv6 和 `10.150.x` 内网 IPv4）。
  所以不是「开个端口就行」，必须走隧道。
- PWA（添加到主屏幕）要求 **https**；麦克风/录音也只在 https 或 localhost 下给。
- 本机跑 DSH 的这台电脑当服务器，`npm start` 只监听 `127.0.0.1:8787`。

## 路线

**Tailscale Funnel**：给本机的 8787 开一个 `https://<机器名>.<tailnet>.ts.net` 的公网地址。
不用路由器、不用公网 IP、不用手机装 App；代价是依赖 Tailscale 的接入点，国内延迟看运气。

私网模式（手机装 Tailscale、只允许同账号设备访问）留作备选：把 `tailscale funnel` 换成
`tailscale serve`，再把手机加进 tailnet。

## 步骤

1. **换密码**：`config.json` 里 `password` 改成强的（这一步不能省，Funnel 一开就是公网可达）。
2. **装 Tailscale**：

   ```powershell
   winget install --id Tailscale.Tailscale -e --accept-package-agreements --accept-source-agreements
   ```

   装完任务栏会出现 Tailscale，点它登录（浏览器里授权）。命令行也可以：

   ```powershell
   tailscale up --hostname openchat
   ```

   它会打印一个登录链接，在浏览器里点同意。

3. **开机自启**（只拉 OpenChat，登录后启动）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
   ```

   删掉：`... -Remove`。日志在 `data\server.log`。

4. **开 Funnel**（把本机 8787 暴露成 https）：

   ```powershell
   tailscale funnel 8787
   ```

   第一次可能要在 Tailscale 管理后台打开 HTTPS / Funnel 开关。
   成功后会打印 `https://<机器名>.<tailnet>.ts.net/`。

5. **手机验证**：浏览器打开那个 https 地址 → 登录 → 分享 → 添加到主屏幕。
   打开后应该没有地址栏；录音按钮要能要到麦克风权限。

## 常见问题

- **打不开 Funnel**：先确认 `tailscale status` 在线；管理后台里这台机器要允许 Funnel。
- **手机打开是 http 或提示不安全**：说明走的是局域网地址，不是 ts.net 的 https。
- **麦克风没权限**：确认是 https 地址（不是 `http://192.168.x.x`），再检查手机浏览器对站点的麦克风权限。
- **电脑一睡就断**：把睡眠关掉，或者接受「用的时候再开」。
- **想换端口/机器名**：Funnel 是按端口开的，换端口要重新 `tailscale funnel`。

## 安全

- 只要 Funnel 开着，这个地址**互联网上谁都能访问到登录页**，靠密码挡。所以：
  密码要强；失败了有锁定（10 分钟 5 次）。
- `config.json` 不进 git。
- 想彻底私密就退到 `tailscale serve`（只允许 tailnet 内设备）。
