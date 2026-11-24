import { nativeApp, PlateReader } from './native'

// Prints the slip or receipt that is on screen (the print stylesheet shows only `.slip`).
// In the Android app the web view cannot print by itself, so the app hands the page to Android's print service.
export async function printSlip() {
  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 150))) // let the slip render first
  if (nativeApp) {
    try { await PlateReader.print({ name: 'PARKER' }); return } catch { /* fall back to the browser */ }
  }
  window.print()
}
