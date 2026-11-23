// Full-screen "Cash received" moment at the exit gate, in three beats:
// 1) three rupee notes fly up and land fanned out, 2) they fold into a gold ₹ coin,
// 3) the coin flips to a green tick with a ripple and sparks while the amount counts up.
// Tap anywhere (or wait) to dismiss.
import { chime } from './done'

const hindi = () => { try { return localStorage.getItem('lang') === 'hi' } catch { return false } }
const inr = (paise: number) => '₹' + Math.round(paise / 100).toLocaleString('en-IN')

const FLIP_AT = 1450   // ms: coin turns to the tick side
let open: HTMLDivElement | null = null

export function cashCelebrate(paise: number, plate: string) {
  open?.remove()
  const el = document.createElement('div')
  open = el
  el.className = 'cash-cel'
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', 'assertive')
  el.setAttribute('aria-label', `Cash received ${inr(paise)} for ${plate}`)
  const note = (i: number) => `<div class="cc-note n${i}"><span class="cc-note-in"><b>₹</b><i></i><i></i><i></i></span></div>`
  const sparks = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2
    const d = 118 + (i % 3) * 30
    return `<i class="cc-spark s${i % 4}" style="--x:${(Math.cos(a) * d).toFixed(1)}px;--y:${(Math.sin(a) * d).toFixed(1)}px;--r:${i * 53}deg;--d:${(i % 4) * 35}ms"></i>`
  }).join('')
  el.innerHTML = `
    <div class="cc-stage">
      <div class="cc-burst">
        <span class="cc-glow"></span>
        <span class="cc-ripple"></span><span class="cc-ripple r2"></span>
        ${sparks}
        ${note(0)}${note(1)}${note(2)}
        <div class="cc-coin"><div class="cc-flip">
          <div class="cc-face cc-front"><span>₹</span></div>
          <div class="cc-face cc-back"><svg viewBox="0 0 52 52" aria-hidden="true"><path class="cc-tick" d="M15 27l7.5 7.5L38 19"/></svg></div>
        </div></div>
      </div>
      <p class="cc-label">${hindi() ? 'नकद मिला' : 'Cash received'}</p>
      <p class="cc-amt num">₹0</p>
      <p class="cc-plate">${plate}</p>
      <p class="cc-hint">${hindi() ? 'आगे बढ़ने के लिए टैप करें' : 'Tap anywhere to continue'}</p>
    </div>`
  document.body.appendChild(el)

  const amt = el.querySelector('.cc-amt') as HTMLElement
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce) amt.textContent = inr(paise)
  else {
    // count up with an ease-out so it settles on the exact amount, then a small thump
    const start = performance.now() + FLIP_AT, len = 650
    const step = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - start) / len))
      amt.textContent = inr(paise * (1 - Math.pow(1 - k, 3)))
      if (k < 1 && el.isConnected) requestAnimationFrame(step)
      else if (k >= 1) amt.classList.add('cc-done')
    }
    requestAnimationFrame(step)
  }

  requestAnimationFrame(() => el.classList.add('cc-on'))
  setTimeout(chime, reduce ? 0 : FLIP_AT + 150)
  if (navigator.vibrate) setTimeout(() => { try { navigator.vibrate([18, 60, 18]) } catch { /* not allowed */ } }, reduce ? 0 : FLIP_AT + 150)

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    el.classList.add('cc-out')
    setTimeout(() => { el.remove(); if (open === el) open = null }, 340)
  }
  // ignore taps during the first half-second so the collect tap itself can't close it
  setTimeout(() => el.addEventListener('pointerdown', close), 500)
  setTimeout(close, 3900)
}
