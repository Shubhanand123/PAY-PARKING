import { nativeApp, PlateReader } from './native'

// Prints the slip or receipt that is on screen.
// 1. POS with a built-in printer (Urovo-based, e.g. TVS i9200): the slip is turned into a 58 mm image
//    (384 dots wide) and sent straight to the printer. No print screen, no tap.
// 2. Otherwise (other Android devices, older app versions): Android's print service, as before.
// 3. In a browser: the browser's print dialog (the print stylesheet shows only `.slip`).

const DOTS = 384 // 58 mm thermal roll at 203 dpi

// Getting ready to print is the slow part (loading the drawing code and turning the Inter font into data).
// It is done once, in the background when the app opens, so the first slip starts printing straight away.
let fonts: Promise<string> | undefined
const drawer = () => import('html-to-image')
function fontCss(node: HTMLElement) {
  fonts ??= drawer().then(m => m.getFontEmbedCSS(node)).catch(() => { fonts = undefined; return '' })
  return fonts
}
/** Call when the app opens: prepares printing in the background. */
export function warmPrinter() {
  const run = () => {
    const probe = document.createElement('div')
    probe.className = 'slip slip-print'
    probe.style.cssText = 'position:fixed;left:-10000px;top:0;width:' + DOTS + 'px'
    probe.innerHTML = '<b class="slip-h">PARKER</b><div class="slip-row"><span>Ticket</span><b>T-000000</b></div>'
    document.body.append(probe)
    void fontCss(probe).finally(() => probe.remove())
  }
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 3000 }); else setTimeout(run, 1500)
}

/** Draws the on-screen slip as a black-on-white picture exactly 384 dots wide. */
export async function slipImage(): Promise<string | undefined> {
  let slip = document.querySelector<HTMLElement>('.slip')
  for (let i = 0; !slip && i < 10; i++) { await new Promise(r => setTimeout(r, 30)); slip = document.querySelector<HTMLElement>('.slip') }
  if (!slip) return undefined
  const { toCanvas } = await drawer()
  // Print a copy laid out at the paper's width, so it looks the same on every screen size.
  const holder = document.createElement('div')
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:' + DOTS + 'px;background:#fff;z-index:-1'
  const copy = slip.cloneNode(true) as HTMLElement
  copy.classList.add('slip-print')
  // 130 dots (~16 mm) of blank paper at the bottom, so the slip comes out far enough to tear off cleanly.
  copy.style.cssText = 'width:' + DOTS + 'px;max-width:none;margin:0;padding:10px 8px 130px;background:#fff;color:#000;box-shadow:none;border-radius:0;-webkit-mask:none;mask:none'
  holder.append(copy)
  document.body.append(holder)
  try {
    await document.fonts?.ready
    const fontEmbedCSS = await fontCss(copy)
    const canvas = await toCanvas(copy, { pixelRatio: 1, backgroundColor: '#ffffff', width: DOTS, cacheBust: false, fontEmbedCSS })
    // Thermal printers have no grey: make every dot pure black or white so text stays crisp.
    const ctx = canvas.getContext('2d')!
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (img.data[i] * 0.3 + img.data[i + 1] * 0.59 + img.data[i + 2] * 0.11) < 150 ? 0 : 255
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    return canvas.toDataURL('image/png')
  } finally { holder.remove() }
}

let builtIn: boolean | undefined
export async function printSlip() {
  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))) // let the slip render first
  if (nativeApp) {
    if (builtIn !== false) {
      try {
        const image = await slipImage()
        if (image) { await PlateReader.printImage({ image }); builtIn = true; return }
      } catch (error) {
        const message = String((error as Error)?.message ?? error)
        // No built-in printer, or an older app without direct printing: use the print screen from now on.
        if (/NO_BUILT_IN_PRINTER|not implemented|is not a function|UNIMPLEMENTED/i.test(message)) builtIn = false
        else printProblem(message.replace(/^Error:\s*/, '')) // a real printer problem (e.g. out of paper): tell the operator, then offer the print screen
      }
    }
    try { await PlateReader.print({ name: 'PARKER' }); return } catch { /* fall back to the browser */ }
  }
  window.print()
}

/** A short message at the bottom of the screen, e.g. "The printer is out of paper." */
function printProblem(text: string) {
  const el = document.createElement('div')
  el.className = 'toast toast-bad'
  el.setAttribute('role', 'alert')
  el.textContent = text + ' Showing the print screen instead.'
  document.body.append(el)
  setTimeout(() => el.remove(), 5000)
}
