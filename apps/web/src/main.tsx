import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const host = document.getElementById('root')
if (!host) throw new Error('找不到 #root')

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// 生产环境注册 SW：先把壳缓存住，冷启动不给白屏 30 秒。
// 开发环境不注册，免得热更新被缓存拦住。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('[sw] 注册失败：', error)
    })
  })
}
