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
// Vehicle icons: Google Material Symbols (Apache 2.0) and Phosphor's jeep for SUV (MIT). Filled shapes, own viewBox.
const VEHICLE: Record<string, [string, string]> = {"bike": ["0 -960 960 960", "M157-200q-65 0-111-45.5T0-357q0-66 45.5-111.5T156-514l-47-36H25q-11 0-18-7t-7-18q0-11 7-18t18-7h156l99 60 149-56q5-2 10.5-3t10.5-1h129l-78-100h-59q-13 0-21.5-8.5T412-730q0-13 8.5-21.5T442-760h60q14 0 26.5 6t20.5 17l68 88 107-53q8-4 15 .5t7 12.5v65q0 6-4.5 10.5T731-609h-83l85 110q17-7 34-10.5t35-3.5q66 0 112 45.5T960-356q0 66-46 111t-112 45q-65 0-110.5-45.5T646-356q0-30 10-57t30-49l-35-45-137 209q-5 6-11 10t-14 4h-82q-5 0-10.5-2t-10.5-6l-72-65q0 66-45.5 111.5T157-200Zm0-60q41 0 69-28.5t28-68.5q0-40-28-68.5T157-454q-40 0-68.5 28T60-357q0 41 28.5 69t68.5 28Zm645 0q41 0 69.5-28t28.5-68q0-41-28.5-69.5T802-454q-40 0-68 28.5T706-356q0 40 28 68t68 28Z"], "auto": ["0 -960 960 960", "M227.91-280q-42.08 0-75-26Q120-332 110-374h-10q-24.75 0-42.37-17.63Q40-409.25 40-434v-346q0-24.75 17.63-42.38Q75.25-840 100-840h513.81q19.19 0 37.19 6 18 6 29 20l152 197q8 11 11 24.5t3 27.5v51q34 15 54 45.26 20 30.27 20 67.74 0 51-35 86t-86 35q-42 0-74.34-26.44T680-374H346q-12 41-44 67.5T227.91-280ZM100-638h189v-142H100v142Zm249 204h236v-346H349v142h111q12.75 0 21.38 8.68 8.62 8.67 8.62 21.5 0 12.82-8.62 21.32-8.63 8.5-21.38 8.5H349v144Zm296-157h127L645-755v164ZM271.5-357.55q17.5-17.56 17.5-43.5 0-25.95-17.55-43.45-17.56-17.5-43.5-17.5-25.95 0-43.45 17.55-17.5 17.56-17.5 43.5 0 25.95 17.55 43.45 17.56 17.5 43.5 17.5 25.95 0 43.45-17.55Zm571 0q17.5-17.56 17.5-43.5 0-25.95-17.55-43.45-17.56-17.5-43.5-17.5-25.95 0-43.45 17.55-17.5 17.56-17.5 43.5 0 25.95 17.55 43.45 17.56 17.5 43.5 17.5 25.95 0 43.45-17.55ZM495-51l-185-96q-5-3-3.91-8.5 1.09-5.5 6.91-5.5h130v-50q0-8 7-13t15-1l184 90q5 2 3.5 8t-7.5 6H517v56q0 8-7 13t-15 1Z"], "car": ["0 -960 960 960", "M200-204v44q0 16.67-11.74 28.33Q176.53-120 159.76-120q-16.76 0-28.26-11.67Q120-143.33 120-160v-304q0-4.67.5-9.33.5-4.67 2.5-9.67l78-236q6-19 21.75-30T258-760h444q19.5 0 35.25 11T759-719l78 236q2 5 2.5 9.67.5 4.66.5 9.33v304q0 16.67-11.74 28.33Q816.53-120 799.76-120 783-120 771-131.96T759-161v-43H200Zm3-330h554l-55-166H258l-55 166Zm82.76 220q23.24 0 38.74-15.75Q340-345.5 340-368q0-23.33-15.75-39.67Q308.5-424 286-424q-23.33 0-39.67 16.26Q230-391.47 230-368.24q0 23.24 16.26 38.74 16.27 15.5 39.5 15.5ZM675-314q23.33 0 39.67-15.75Q731-345.5 731-368q0-23.33-16.26-39.67Q698.47-424 675.24-424q-23.24 0-38.74 16.26-15.5 16.27-15.5 39.5 0 23.24 15.75 38.74Q652.5-314 675-314Z"], "suv": ["0 0 256 256", "M248,103.47A8.17,8.17,0,0,0,239.73,96H232a8,8,0,0,0-.18-1.68L221.18,44.65A16.08,16.08,0,0,0,205.53,32H50.47A16.08,16.08,0,0,0,34.82,44.65L24.18,94.32A8,8,0,0,0,24,96H16.27A8.17,8.17,0,0,0,8,103.47,8,8,0,0,0,16,112h8v88a16,16,0,0,0,16,16H64a16,16,0,0,0,16-16V184h20a4,4,0,0,0,4-4V128.27a8.17,8.17,0,0,1,7.47-8.25,8,8,0,0,1,8.53,8v52a4,4,0,0,0,4,4h8a4,4,0,0,0,4-4V128.27a8.17,8.17,0,0,1,7.47-8.25,8,8,0,0,1,8.53,8v52a4,4,0,0,0,4,4h20v16a16,16,0,0,0,16,16h24a16,16,0,0,0,16-16V112h8A8,8,0,0,0,248,103.47ZM68,144a12,12,0,1,1,12-12A12,12,0,0,1,68,144Zm120,0a12,12,0,1,1,12-12A12,12,0,0,1,188,144ZM40.18,96,50.47,48H205.53l10.29,48Z"], "van": ["0 -960 960 960", "M152-232.08q-32-32.09-32-77.92h-20q-24.75 0-42.37-17.63Q40-345.25 40-370v-330q0-24.75 17.63-42.38Q75.25-760 100-760h561q12.44 0 23.72 5T704-742l198 198q8 8 13 19.28 5 11.28 5 23.72v131q0 24.75-17.62 42.37Q884.75-310 860-310h-20q0 46-32.12 78t-78 32Q684-200 652-232.08q-32-32.09-32-77.92H340q0 46-32.12 78t-78 32Q184-200 152-232.08ZM600-560h194L654-700h-54v140Zm-250 0h190v-140H350v140Zm-250 0h190v-140H100v140Zm172.5 292.64q17.5-17.36 17.5-42.5t-17.36-42.64q-17.36-17.5-42.5-17.5t-42.64 17.36q-17.5 17.36-17.5 42.5t17.36 42.64q17.36 17.5 42.5 17.5t42.64-17.36Zm500 0q17.5-17.36 17.5-42.5t-17.36-42.64q-17.36-17.5-42.5-17.5t-42.64 17.36q-17.5 17.36-17.5 42.5t17.36 42.64q17.36 17.5 42.5 17.5t42.64-17.36Z"], "truck": ["0 -960 960 960", "M302-202v39q0 17.92-12.56 30.46T258.94-120q-17.94 0-30.44-12.54T216-163v-68q-29-16-42.5-46T160-341v-397q0-73.66 76.5-107.83T481-880q166 0 242.5 34T800-738v397q0 34-13.5 64T744-231v68q0 17.92-12.56 30.46T700.94-120q-17.94 0-30.44-12.54T658-163v-39H302Zm-82-329h520v-173H220v173Zm145 202.94q16-16.06 16-39T364.94-406q-16.06-16-39-16T287-405.94q-16 16.06-16 39T287.06-328q16.06 16 39 16T365-328.06Zm308 0q16-16.06 16-39T672.94-406q-16.06-16-39-16T595-405.94q-16 16.06-16 39T595.06-328q16.06 16 39 16T673-328.06Z"]}
export function Ico({ n, size = 20, className }: { n: string; size?: number; className?: string }) {
  const v = VEHICLE[n]
  if (v) return <svg className={className} width={size} height={size} viewBox={v[0]} fill="currentColor" aria-hidden="true"><path d={v[1]} /></svg>
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: P[n] ?? '' }} />
}

/** A QR drawn as vector shapes: razor sharp at any size, on screen and on the printed slip. */
export function QR({ text, size = 132, level = 'M' }: { text: string; size?: number; level?: 'M' | 'H' }) {
  const [svg, setSvg] = useState('')
  useEffect(() => { QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: level, color: { dark: '#000000', light: '#ffffff' } }).then(setSvg) }, [text, level])
  return <div className="qr-svg" role="img" aria-label="QR code" style={{ width: size, height: size, maxWidth: '100%', aspectRatio: '1' }} dangerouslySetInnerHTML={{ __html: svg }} />
}

export function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'info' | 'mute'; children: ReactNode }) {
  return <span className={'pill pill-' + tone}>{children}</span>
}

export function Toast({ msg, tone = 'ok', onDone }: { msg: string; tone?: 'ok' | 'bad'; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3500); return () => clearTimeout(t) }, [msg, onDone])
  return <div className={'toast toast-' + tone} role="status">{msg}</div>
}

export const ticketUrl = (token: string) => location.href.split('#')[0] + '#/t/' + token
