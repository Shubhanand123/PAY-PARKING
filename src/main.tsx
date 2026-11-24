import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './tokens.css'
import './base.css'
import './app.css'
import './done.css'
import './fx.css'
import './pos.css'
import App from './App'
import { AppUpdate } from './AppUpdate'
createRoot(document.getElementById('root')!).render(<StrictMode><AppUpdate /><App /></StrictMode>)
// Offline copy of the app (public/sw.js): opens instantly and works with no internet. Website builds only.
if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol === 'https:' && !location.hostname.startsWith('localhost')) {
  addEventListener('load', () => { void navigator.serviceWorker.register('./sw.js').catch(() => {}) })
}
