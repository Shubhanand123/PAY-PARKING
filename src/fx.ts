// Full-screen moments for the gate POS: already inside, ticket cancelled.
// Plain DOM, same pattern as celebrate.ts. Tap (after 0.5s) or wait to close.

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
let open: HTMLDivElement | null = null
let ctx: AudioContext | null = null

function tone(kind: 'buzz' | 'thud') {
  try {
    ctx ??= new AudioContext(); const t = ctx.currentTime
    const o = ctx.createOscillator(), g = ctx.createGain()
    if (kind === 'buzz') { o.type = 'square'; o.frequency.value = 180; g.gain.setValueAtTime(.2, t + .45); g.gain.exponentialRampToValueAtTime(.001, t + .75) ; o.start(t + .45); o.stop(t + .8) }
    else { o.type = 'triangle'; o.frequency.setValueAtTime(140, t + .9); o.frequency.exponentialRampToValueAtTime(45, t + 1.1); g.gain.setValueAtTime(1, t + .9); g.gain.exponentialRampToValueAtTime(.001, t + 1.12); o.start(t + .9); o.stop(t + 1.15) }
    o.connect(g).connect(ctx.destination)
  } catch { /* no audio */ }
}

function show(cls: string, bg: string, html: string, ms: number) {
  open?.remove()
  const el = document.createElement('div'); open = el
  el.className = 'fxov ' + cls; el.style.background = bg
  el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'assertive')
  el.innerHTML = html
  document.body.appendChild(el)
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')))
  let closed = false
  const close = () => { if (closed) return; closed = true; el.classList.add('out'); setTimeout(() => { el.remove(); if (open === el) open = null }, 320) }
  setTimeout(() => el.addEventListener('pointerdown', close), 500)
  setTimeout(close, ms)
}

export function alreadyInside(plate: string, sub: string) {
  show('U', 'radial-gradient(circle at 50% 40%,rgba(229,72,77,.28),transparent 60%),rgba(9,16,38,.95)', `<div class="stage"><div class="pw"><div class="plate">${esc(plate)}</div><span class="bang">!</span></div>
    <div class="why"><b>Already inside</b><small>${esc(sub)}<br>A second ticket was not made.</small></div></div>`, 3000)
  tone('buzz')
  if (navigator.vibrate) try { navigator.vibrate([60, 60, 60]) } catch { /* */ }
}

export function ticketCancelled(plate: string, id: string, when: string) {
  const t = (h: string) => `<div class="tk ${h}"><small>TICKET ${esc(id)}</small><br><span class="pb">${esc(plate)}</span><div class="ln"></div><div class="ln" style="width:60%"></div><div class="cst">CANCELLED</div></div>`
  show('X', 'rgba(9,16,38,.94)', `<div class="stage shake"><div style="position:relative;height:190px;display:grid;place-items:center"><div class="tw">${t('hl')}${t('hr')}</div></div>
    <div class="msg"><b>Ticket cancelled</b><small>Logged for the owner · ${esc(when)}</small></div></div>`, 3200)
  tone('thud')
}
