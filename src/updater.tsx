// Over-the-internet updates for the POS and the dashboard.
// The app checks for a new version every few minutes and whenever it comes back on screen. The new version is
// downloaded quietly, then switched to only at a safe moment: on a POS, when it is on the empty Entry/Exit home
// screen, nothing is typed or open, and nobody has touched it for a while. On the dashboard the Owner taps to refresh.
import { useEffect, useState } from 'react'

const CHECK_EVERY = 60 * 60_000      // normal updates: once an hour (and when the app opens)
const URGENT_EVERY = 3 * 60_000      // important updates: a tiny file is checked every 3 minutes
const IDLE_NORMAL = 30_000, IDLE_URGENT = 2_000 // important: as soon as the POS is free

// ---------- "busy" signals from the gate screens ----------
const busy = new Map<string, boolean>()
/** A gate screen says whether it is in the middle of something (plate typed, ticket open, payment, slip…). */
export function setBusy(key: string, value: boolean) { busy.set(key, value) }
let lastTouch = Date.now()
for (const ev of ['pointerdown', 'keydown', 'input', 'touchstart', 'wheel'] as const) addEventListener(ev, () => { lastTouch = Date.now() }, { passive: true, capture: true })

function safeNow(urgent: boolean) {
  if ([...busy.values()].some(Boolean)) return false
  const active = document.activeElement
  if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return false
  if (document.visibilityState !== 'visible') return false
  return Date.now() - lastTouch >= (urgent ? IDLE_URGENT : IDLE_NORMAL)
}

// ---------- finding a new version ----------
/** This version's fingerprint: the names of its script and style files (they change with every build). */
const currentScript = () => [...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src*="/assets/"], link[rel="stylesheet"][href*="/assets/"]')]
  .map(el => ('src' in el && el.src ? el.src : (el as HTMLLinkElement).href).split('/assets/')[1]).sort().join('|')

async function latest(): Promise<{ script: string; urgent: boolean } | null> {
  try {
    const [page, info] = await Promise.all([
      fetch('./?fresh=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.text() : ''),
      fetch('./web-version.json?fresh=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ])
    const script = [...page.matchAll(/(?:src|href)="[^"]*\/assets\/([^"]+\.(?:js|css))"/g)].map(m => m[1]).sort().join('|')
    return script ? { script, urgent: Boolean((info as { urgent?: boolean }).urgent) } : null
  } catch { return null }
}

/** Ask the offline copy (service worker) to save the new version now, so the switch is instant. */
async function prefetch() {
  const sw = navigator.serviceWorker?.controller
  if (!sw) return
  await new Promise<void>(resolve => {
    const channel = new MessageChannel()
    const done = setTimeout(resolve, 15_000)
    channel.port1.onmessage = () => { clearTimeout(done); resolve() }
    sw.postMessage({ type: 'refresh' }, [channel.port2])
  })
}

/** Top strip (POS) or bar (dashboard). Renders nothing until an update is ready. */
export function UpdateBar() {
  const [dashboard, setDashboard] = useState(() => location.hash.startsWith('#/owner'))
  useEffect(() => { const f = () => setDashboard(location.hash.startsWith('#/owner')); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  const [ready, setReady] = useState<{ urgent: boolean } | null>(null)
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    if (!import.meta.env.PROD || !currentScript()) return
    let alive = true
    const check = async () => {
      const found = await latest()
      if (!alive || !found || found.script === currentScript()) return
      await prefetch()
      if (alive) setReady({ urgent: found.urgent })
    }
    // Important update: web-version.json says urgent with a new id. Then look for the new version straight away.
    let seenUrgent = ''
    const urgentCheck = async () => {
      try {
        const info = await fetch('./web-version.json?fresh=' + Date.now(), { cache: 'no-store' }).then(r => r.json()) as { urgent?: boolean; id?: string }
        if (info.urgent && info.id && info.id !== seenUrgent) { seenUrgent = info.id; await check() }
      } catch { /* offline */ }
    }
    void check()
    addEventListener('parker-check-update', check) // lets a test (or a future button) check now
    const timer = setInterval(check, CHECK_EVERY)
    const urgentTimer = setInterval(urgentCheck, URGENT_EVERY)
    return () => { alive = false; clearInterval(timer); clearInterval(urgentTimer); removeEventListener('parker-check-update', check) }
  }, [])

  // POS: switch by itself at a safe moment only.
  useEffect(() => {
    if (!ready || dashboard) return
    const timer = setInterval(() => {
      if (!safeNow(ready.urgent)) return
      clearInterval(timer)
      setSwitching(true)
      setTimeout(() => location.reload(), 900)
    }, 1000)
    return () => clearInterval(timer)
  }, [ready, dashboard])

  if (!ready) return null
  if (!dashboard) return switching ? <div className="upd-strip" role="status"><span className="upd-spin" />Updating PARKER…</div> : null
  return <div className={'upd-bar' + (ready.urgent ? ' urgent' : '')} role="status">
    <span>{ready.urgent ? 'Important update ready' : 'Update ready'}</span>
    <button onClick={() => location.reload()}>Tap to refresh</button>
  </div>
}
