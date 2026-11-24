import { useEffect, useState, type ReactNode } from 'react'
import QRCode from 'qrcode'
import { load, type DB } from './engine'

/** Live copy of the data. Re-reads on every change, in this tab or another tab (two "gates"). */
export function useDB(): DB {
  const [db, setDb] = useState(load)
  useEffect(() => {
    const r = () => setDb(load())
    window.addEventListener('parking-change', r)
    window.addEventListener('storage', r)
    const i = setInterval(r, 15000) // keep running totals fresh
    return () => { window.removeEventListener('parking-change', r); window.removeEventListener('storage', r); clearInterval(i) }
  }, [])
  return db
}

export function useNow(ms = 30000) {
  const [n, setN] = useState(Date.now())
  useEffect(() => { const i = setInterval(() => setN(Date.now()), ms); return () => clearInterval(i) }, [ms])
  return n
}

const P: Record<string, string> = {
  bike: '<circle cx="5.2" cy="16.4" r="3.3"/><circle cx="18.8" cy="16.4" r="3.3"/><circle cx="5.2" cy="16.4" r=".9" fill="currentColor"/><circle cx="18.8" cy="16.4" r=".9" fill="currentColor"/><path fill="currentColor" fill-opacity=".16" d="M8.2 12.6h6.3l1.6-2.6H10.4z"/><path d="M5.2 16.4l3.3-5.2h5.8l2.3-3.4M8.7 9.3h3.6M16.6 7.8l-1-1.6h2.6M16.6 7.8l2.2 8.6M10.6 16.4h4.6"/>',
  auto: '<path fill="currentColor" fill-opacity=".16" d="M3 13.2V9.4C3 6.7 5 5 7.6 5h6.6c1.1 0 2 .6 2.5 1.5l3.3 5.6v3.2c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1z"/><path d="M3 15.2V9.4C3 6.7 5 5 7.6 5h6.6c1.1 0 2 .6 2.5 1.5l3.3 5.6v3.2"/><path d="M6 7.6h5.2v4.8H6zM13.6 7.6h1.5l2.3 4.2h-3.8z"/><circle cx="6.8" cy="17" r="2"/><circle cx="17.6" cy="17" r="2"/><path d="M8.8 16.4h6.8M2.4 16.4h2.4"/>',
  car: '<path fill="currentColor" fill-opacity=".16" d="M2.6 15.4v-2.1c0-.8.5-1.4 1.2-1.6l2.3-.7 2.4-3.3c.4-.5 1-.8 1.6-.8h5.1c.6 0 1.2.3 1.6.8l2.7 3.3 1.8.5c.8.2 1.3.9 1.3 1.7v2.2c0 .5-.4.9-.9.9H3.5c-.5 0-.9-.4-.9-.9z"/><path d="M4.7 16.3H3.5c-.5 0-.9-.4-.9-.9v-2.1c0-.8.5-1.4 1.2-1.6l2.3-.7 2.4-3.3c.4-.5 1-.8 1.6-.8h5.1c.6 0 1.2.3 1.6.8l2.7 3.3 1.8.5c.8.2 1.3.9 1.3 1.7v2.2c0 .5-.4.9-.9.9h-1.2M9.3 16.3h5.4"/><path d="M8.7 11l1.5-2.1h2.3V11zM14.2 11V8.9h1.3l1.7 2.1z"/><circle cx="7" cy="16.6" r="2.2"/><circle cx="17" cy="16.6" r="2.2"/>',
  suv: '<path fill="currentColor" fill-opacity=".16" d="M2.4 15.4V10.8c0-.6.4-1.1 1-1.3l1.7-.5 1.5-3c.3-.6.9-1 1.6-1h8.6c.6 0 1.1.3 1.4.8l1.9 3.2 1.4.5c.6.2 1.1.8 1.1 1.4v4.5c0 .5-.4.9-.9.9H3.3c-.5 0-.9-.4-.9-.9z"/><path d="M4.4 16.3H3.3c-.5 0-.9-.4-.9-.9V10.8c0-.6.4-1.1 1-1.3l1.7-.5 1.5-3c.3-.6.9-1 1.6-1h8.6c.6 0 1.1.3 1.4.8l1.9 3.2 1.4.5c.6.2 1.1.8 1.1 1.4v4.5c0 .5-.4.9-.9.9h-1.1M9.1 16.3h5.8"/><path d="M7 9.4l1.1-2.3h3.3v2.3zM13.1 9.4V7.1h3l1.4 2.3zM7.6 4.4h8.8"/><circle cx="6.8" cy="16.6" r="2.4"/><circle cx="17.2" cy="16.6" r="2.4"/>',
  van: '<path fill="currentColor" fill-opacity=".16" d="M2.4 15.4V7.2c0-.8.7-1.5 1.5-1.5h11.5c.5 0 1 .2 1.3.6l3.9 4.6c.3.3.4.7.4 1.1v3.4c0 .5-.4.9-.9.9H3.3c-.5 0-.9-.4-.9-.9z"/><path d="M4.4 16.3H3.3c-.5 0-.9-.4-.9-.9V7.2c0-.8.7-1.5 1.5-1.5h11.5c.5 0 1 .2 1.3.6l3.9 4.6c.3.3.4.7.4 1.1v3.4c0 .5-.4.9-.9.9h-1M8.9 16.3h6"/><path d="M4.5 7.8h3.4v2.9H4.5zM9.6 7.8H13v2.9H9.6zM14.9 7.8h.7l2.4 2.9h-3.1zM2.4 12.6h18.2"/><circle cx="6.6" cy="16.6" r="2.2"/><circle cx="17.1" cy="16.6" r="2.2"/>',
  truck: '<path fill="currentColor" fill-opacity=".16" d="M1.6 14.6V5.4c0-.6.4-1 1-1h10.3c.6 0 1 .4 1 1v9.2z"/><path d="M1.6 14.6V5.4c0-.6.4-1 1-1h10.3c.6 0 1 .4 1 1v9.2"/><path fill="currentColor" fill-opacity=".16" d="M13.9 7.9h4c.4 0 .8.2 1 .5l2.6 3.5c.1.2.2.4.2.6v3c0 .5-.4.9-.9.9h-6.9z"/><path d="M13.9 7.9h4c.4 0 .8.2 1 .5l2.6 3.5c.1.2.2.4.2.6v3c0 .5-.4.9-.9.9h-.9M15.4 9.5h2.3l1.7 2.4h-4zM1.6 14.6v1.3c0 .2.2.4.4.4h1.3M8.4 16.3h7.2"/><circle cx="5.7" cy="16.7" r="2.1"/><circle cx="17.9" cy="16.7" r="2.1"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2"/>',
  key: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
  print: '<path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2"/><rect x="7" y="14" width="10" height="6" rx="1"/>',
  cash: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9v.01M18 15v.01"/>',
  out: '<path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M10 16l4-4-4-4M14 12H4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  rupee: '<path d="M6 4h12M6 9h12M9 4c6 0 6 10 0 10H6l8 6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.01"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  p: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M9.5 17V7h3.5a3 3 0 0 1 0 6H9.5"/>',
  dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
}
export function Ico({ n, size = 20, className }: { n: string; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: P[n] ?? '' }} />
}

export function QR({ text, size = 132, level = 'M' }: { text: string; size?: number; level?: 'M' | 'H' }) {
  const [src, setSrc] = useState('')
  useEffect(() => { QRCode.toDataURL(text, { margin: 1, width: size * 2, errorCorrectionLevel: level }).then(setSrc) }, [text, size, level])
  return src ? <img src={src} width={size} height={size} alt="Ticket QR code" /> : <div style={{ width: size, height: size }} />
}

export function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'info' | 'mute'; children: ReactNode }) {
  return <span className={'pill pill-' + tone}>{children}</span>
}

export function Toast({ msg, tone = 'ok', onDone }: { msg: string; tone?: 'ok' | 'bad'; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3500); return () => clearTimeout(t) }, [msg, onDone])
  return <div className={'toast toast-' + tone} role="status">{msg}</div>
}

export const ticketUrl = (token: string) => location.href.split('#')[0] + '#/t/' + token
