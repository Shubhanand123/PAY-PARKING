// Apple Pay style feedback for saves, shown on the button that was pressed: a spinner while the
// save runs, then a ring that closes into a drawn tick with "Saved" / "Approved", and a chime. Plain DOM so every screen gets it with no wiring.
type Run = { btn: HTMLElement | null; rect: DOMRect; el: HTMLDivElement; shown: boolean }
let last: { btn: HTMLElement; at: number } | null = null
let run: Run | null = null
let busy = 0
let showT = 0
let guardT = 0

// never leave a badge on screen: a save that hangs, or the page changing under it, clears it
function clearAll() {
  busy = 0; clearTimeout(showT); clearTimeout(guardT)
  if (run) { run.el.remove(); run = null }
  document.querySelectorAll('.pay-done:not(.pd-ok)').forEach(e => e.remove())
}
addEventListener('popstate', clearAll)
addEventListener('hashchange', clearAll)
document.addEventListener('visibilitychange', () => { if (document.hidden) clearAll() })

document.addEventListener('pointerdown', e => {
  const b = (e.target as HTMLElement | null)?.closest?.('button, [role=button]') as HTMLElement | null
  if (b) last = { btn: b, at: Date.now() }
}, true)
document.addEventListener('keydown', e => {
  const b = document.activeElement as HTMLElement | null
  if ((e.key === 'Enter' || e.key === ' ') && b?.matches('button')) last = { btn: b, at: Date.now() }
}, true)

const HI: Record<string, string> = { Saved: 'सेव हो गया', Approved: 'मंज़ूर', Rejected: 'नामंज़ूर', Paid: 'पैसे मिले', Done: 'हो गया', Closed: 'बंद', Cancelled: 'रद्द', Published: 'लागू' }
const hindi = () => { try { return localStorage.getItem('lang') === 'hi' } catch { return false } }
const say = (label: string) => hindi() ? HI[label] ?? label : label

function place(r: Run) {
  if (r.btn?.isConnected) r.rect = r.btn.getBoundingClientRect()
  const { left, top, width, height } = r.rect
  const radius = r.btn ? getComputedStyle(r.btn).borderRadius : '14px'
  Object.assign(r.el.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px', borderRadius: radius })
  // a narrow button can't hold tick + word: grow the badge around its centre so nothing is cut off
  const need = r.el.scrollWidth
  if (need > width) {
    const w = Math.min(need + 24, innerWidth - 16)
    const x = Math.max(8, Math.min(innerWidth - 8 - w, left + width / 2 - w / 2))
    Object.assign(r.el.style, { left: x + 'px', width: w + 'px', borderRadius: '999px' })
  }
}

function make(): Run {
  const btn = last && Date.now() - last.at < 2000 && last.btn.isConnected ? last.btn : null
  const el = document.createElement('div')
  el.className = 'pay-done'
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', 'polite')
  el.innerHTML = '<svg viewBox="0 0 52 52" aria-hidden="true"><circle class="pd-ring" cx="26" cy="26" r="23"/><path class="pd-tick" d="M15 27l7.5 7.5L38 19"/></svg><b class="pd-label"></b>'
  const rect = btn ? btn.getBoundingClientRect() : new DOMRect(innerWidth / 2 - 110, innerHeight - 90, 220, 52)
  const r = { btn, rect, el, shown: false }
  if (!btn) el.classList.add('pd-float')
  place(r)
  document.body.appendChild(el)
  return r
}

let ctx: AudioContext | null = null
export function chime() {
  try {
    ctx ??= new AudioContext()
    const t = ctx.currentTime
    const out = ctx.createGain(); out.gain.value = 0.22; out.connect(ctx.destination)
    // two soft bell notes a fifth apart, each with a few quiet overtones for a glassy ring
    for (const [f, d] of [[1174.7, 0], [1760, 0.09]] as const) {
      for (const [m, v] of [[1, 1], [2, 0.28], [3.01, 0.08], [4.2, 0.04]] as const) {
        const o = ctx.createOscillator(), g = ctx.createGain()
        o.type = 'sine'; o.frequency.value = f * m
        g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(v, t + d + 0.006)
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + (m === 1 ? 0.9 : 0.35))
        o.connect(g).connect(out); o.start(t + d); o.stop(t + d + 1)
      }
    }
  } catch { /* no audio */ }
}

export function saveStart() {
  busy++
  if (busy > 1 || run) return
  run = make()
  const r = run
  clearTimeout(showT)
  // quick saves skip the spinner and go straight to the tick
  showT = window.setTimeout(() => { r.shown = true; r.el.classList.add('pd-on', 'pd-busy') }, 200)
  clearTimeout(guardT)
  guardT = window.setTimeout(clearAll, 12000)
}

export function saveEnd(ok: boolean, label: string): Promise<void> {
  busy = Math.max(0, busy - 1)
  if (busy || !run) return Promise.resolve()
  clearTimeout(showT); clearTimeout(guardT)
  const r = run
  run = null
  if (!r.btn?.isConnected && r.btn) { r.el.remove(); return Promise.resolve() }
  if (!ok) { r.el.remove(); return Promise.resolve() }
  const word = say(label)
  ;(r.el.querySelector('.pd-label') as HTMLElement).textContent = word
  place(r)
  r.el.classList.add('pd-on', 'pd-busy')
  void r.el.offsetWidth
  r.el.classList.replace('pd-busy', 'pd-ok')
  chime()
  if (navigator.vibrate) try { navigator.vibrate(12) } catch { /* not allowed */ }
  // resolves once the badge has fully faded, so a caller can change screen only after the animation ends
  return new Promise(done => window.setTimeout(() => { r.el.classList.add('pd-out'); window.setTimeout(() => { r.el.remove(); done() }, 300) }, 1300))
}

/** Next badge floats at the bottom of the screen instead of sitting on the pressed button (use when the button goes away). */
export function saveFloat() { last = null }
