// Parking engine. In milestone 1 this runs in the browser and saves to localStorage, standing in
// for the server. Every rule lives here so it can move to Supabase (Postgres functions) unchanged.
// Money is always integer paise. Times are stored as UTC epoch ms and shown in Asia/Kolkata.

export type Role = 'attendant' | 'owner'
export type Staff = { id: string; name: string; role: Role; gate: string }
export type Category = { id: string; name: string; icon: string; active: boolean }

/** One price rule per vehicle type, inside a tariff version. */
export type Rate = {
  firstHours: number      // first slab length in hours, e.g. 2
  firstPaise: number      // price for the first slab, e.g. 3000 = ₹30
  perHourPaise: number    // each started hour after the slab
  capPaise: number        // max per 24 hours (0 = no cap)
}
export type TariffVersion = {
  id: string; version: number; createdAt: number; createdBy: string; note: string
  graceMin: number
  rates: Record<string, Rate> // by category id
}
export type Settings = {
  siteName: string; operator: string; address: string; phone: string
  payAtEntry: boolean
  cancelNeedsReason: boolean
  capacity: number       // total spaces; 0 = not tracked
  gstin?: string         // GST number, printed on slips and receipts
}
export type Status = 'inside' | 'paid' | 'exited' | 'cancelled'
export type Payment = { id: string; ticketId: string; amountPaise: number; method: 'cash' | 'razorpay'; providerPaymentId?: string; at: number; by: string; kind: 'prepaid' | 'exit'; receiptNo: string }
export type OnlineCheckout = { orderId: string; amount: number; currency: 'INR'; receipt: string; billedAt: number; totalPaise: number; linkUrl?: string
  upiQr?: string    // Razorpay UPI QR content (upi://pay?...), shown big on the POS
  qrImage?: string  // Razorpay's own QR image, used if upiQr is missing
  byCustomer?: boolean // started by the customer on their phone (slip QR page): paying it does not end the stay
}
export type Ticket = {
  id: string            // human ticket number, e.g. T-000123
  token: string         // opaque QR token
  plate: string         // normalized, e.g. MH12AB1234
  category: string
  site: string
  entryGate: string; entryBy: string; entryAt: number
  tariffId: string
  prepaidHours: number  // 0 if not pay-at-entry
  status: Status
  exitGate?: string; exitBy?: string; exitAt?: number
  onlineCheckout?: OnlineCheckout
  upiCheck?: { orderId: string; amount: number; at: number; by: string; flagged?: boolean }  // UPI confirmed by the operator; waiting for Razorpay
  billedAt?: number     // time the exit bill was locked
  totalPaise?: number   // full charge for the stay
  cancelledBy?: string; cancelledAt?: number; cancelReason?: string
  prints: number        // entry slip prints (first print + reprints)
  receiptPrints?: number // exit receipt prints (first print + reprints)
  receipt?: Receipt     // exact copy of the receipt, frozen when payment was completed
  free?: FreeExit       // set when the exit was free for a designated vehicle
  rev: number           // bumps on every change; stale writes are refused
}

/** A vehicle the owner lets park free (staff, police, ambulance…). Matched by plate at the exit. */
export type FreeVehicle = { plate: string; reason: string; note?: string; addedAt: number; addedBy: string; active: boolean; removedAt?: number; removedBy?: string }
export type FreeExit = { reason: string; waivedPaise: number }

/** Everything printed on the exit receipt, frozen when the bill is paid, so every reprint and the
 *  Owner dashboard show exactly what the customer was given, even if settings change later. */
export type Receipt = {
  receiptNo: string; issuedAt: number; issuedBy: string
  operator: string; siteName: string; address: string; phone: string; gstin?: string
  ticketId: string; plate: string; vehicle: string; entryAt: number; entryGate: string
  billedAt: number; minutes: number; lines: Line[]; totalPaise: number
  payments: { method: Payment['method']; kind: Payment['kind']; amountPaise: number; receiptNo: string; phone?: boolean; at?: number }[]
  free?: FreeExit
}
export type AuditKind = 'entry' | 'print' | 'reprint' | 'receipt_print' | 'receipt_reprint' | 'free_vehicle' | 'lookup_plate' | 'lookup_qr' | 'plate_fix' | 'payment' | 'exit' | 'cancel' | 'tariff' | 'settings' | 'duplicate_blocked' | 'login'
export type Audit = { id: string; at: number; by: string; kind: AuditKind; ticketId?: string; text: string; amountPaise?: number }

export type DB = {
  razorpayEnabled?: boolean
  razorpayTest?: boolean
  seq: number
  staff: Staff[]
  categories: Category[]
  tariffs: TariffVersion[]
  settings: Settings
  tickets: Ticket[]
  payments: Payment[]
  audit: Audit[]
  freeVehicles?: FreeVehicle[]
  offlineIssues?: { at: number; opId: string; ticketId: string; device?: string; text: string; resolved?: boolean }[]  // offline work the Owner should check
  offlineSeen?: string[]   // op ids already recorded (latest 3000)
  gateLock?: boolean       // Owner: gates work only on approved POS machines
}

const KEY = 'parking-demo-v1'
const HOUR = 3600_000, MIN = 60_000

// ---------- money and time ----------
export const rupees = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 })
const IST = 'Asia/Kolkata'
export const fmtTime = (t: number) => new Date(t).toLocaleTimeString('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true })
export const fmtDate = (t: number) => new Date(t).toLocaleDateString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric' })
export const fmtDT = (t: number) => `${fmtDate(t)}, ${fmtTime(t)}`
export const istDay = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: IST }) // YYYY-MM-DD
export const istHour = (t: number) => Number(new Date(t).toLocaleString('en-GB', { timeZone: IST, hour: '2-digit', hour12: false }))
export function dur(ms: number) {
  const m = Math.max(0, Math.round(ms / MIN)); const h = Math.floor(m / 60)
  return h ? `${h}h ${m % 60}m` : `${m}m`
}

// ---------- Indian registration plates ----------
// Normalized form: uppercase letters and digits only. We never reject a plate for its shape; we only warn.
// Patterns checked (from MoRTH / CMVR conventions):
//  standard  SS RR X(XX) NNNN   e.g. MH12AB1234, DL3CAB1234, KA01A1234
//  Bharat    YY BH NNNN X(X)    e.g. 22BH1234AA  (Bharat series, MoRTH notification Aug 2021)
//  temporary T MMYY SS NNNN XX  e.g. T0124MH1234AB (format varies by state, so only a light check)
export const STATES = 'AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB'.split(' ')
export function normPlate(s: string) { return s.toUpperCase().replace(/[^A-Z0-9]/g, '') }
// Gate validation checks the printed format. It does not query the vehicle registry.
export function isSupportedPlateFormat(input: string) {
  const plate = normPlate(input)
  const standard = /^([A-Z]{2})(?:0[1-9]|[1-9]\d?)[A-Z]{0,3}\d{4}$/.exec(plate)
  if (standard && STATES.includes(standard[1])) return true
  if (/^\d{2}BH\d{4}[A-HJ-NP-Z]{1,2}$/.test(plate)) return true
  const temp = /^T(?:0[1-9]|1[0-2])\d{2}([A-Z]{2})\d{4}[A-HJ-NP-Z]{1,2}$/.exec(plate)
  return Boolean(temp && STATES.includes(temp[1]))
}
export type PlateCheck = { kind: 'standard' | 'bharat' | 'temporary' | 'unknown'; pretty: string; hint?: string; suggestion?: string }
export function checkPlate(raw: string): PlateCheck {
  const p = normPlate(raw)
  let m = p.match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/)
  if (m && STATES.includes(m[1])) return { kind: 'standard', pretty: [m[1], m[2], m[3], m[4]].filter(Boolean).join(' ') }
  m = p.match(/^(\d{2})BH(\d{4})([A-Z]{1,2})$/)
  if (m) return { kind: 'bharat', pretty: `${m[1]} BH ${m[2]} ${m[3]}` }
  if (/^T\d{4}[A-Z]{2}\d{1,4}[A-Z]{0,2}$/.test(p)) return { kind: 'temporary', pretty: p }
  // Try fixing common OCR mix-ups: letters in the state/series part, digits in number parts.
  const fixed = fixOcr(p)
  if (fixed !== p && checkPlate(fixed).kind !== 'unknown') return { kind: 'unknown', pretty: p, hint: 'Looks unusual. Did you mean this?', suggestion: fixed }
  return { kind: 'unknown', pretty: p, hint: p.length < 6 ? 'Too short for a registration number.' : 'Unusual format. Check it, then confirm.' }
}
function fixOcr(p: string) {
  const toL: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z' }
  const toD: Record<string, string> = { O: '0', I: '1', S: '5', B: '8', Z: '2', D: '0', Q: '0' }
  if (p.length < 6) return p
  const a = p.split('')
  for (let i = 0; i < 2; i++) a[i] = toL[a[i]] ?? a[i]
  for (let i = 2; i < 4; i++) a[i] = toD[a[i]] ?? a[i]
  for (let i = a.length - 4; i < a.length; i++) a[i] = toD[a[i]] ?? a[i]
  return a.join('')
}
export const prettyPlate = (p: string) => checkPlate(p).pretty

// ---------- the bill ----------
export type Line = { label: string; paise: number }
export type Bill = { minutes: number; chargedHours: number; lines: Line[]; totalPaise: number; prepaidPaise: number; duePaise: number; inGrace: boolean; free?: FreeExit }

/** Charge for one stay of `minutes`, under `rate` with `graceMin`. Pure: the same inputs always give the same bill. */
export function charge(minutes: number, rate: Rate, graceMin: number): { lines: Line[]; total: number; hours: number; inGrace: boolean } {
  if (minutes <= graceMin) return { lines: [{ label: `Within ${graceMin}-min grace`, paise: 0 }], total: 0, hours: 0, inGrace: true }
  const lines: Line[] = []
  let total = 0
  const days = Math.floor(minutes / (24 * 60))
  let rest = minutes - days * 24 * 60
  const dayCharge = (mins: number) => {
    if (mins <= 0) return { p: 0, extra: 0 }
    const hrs = Math.ceil(mins / 60) // every started hour
    const extra = Math.max(0, hrs - rate.firstHours)
    return { p: rate.firstPaise + extra * rate.perHourPaise, extra }
  }
  const full = dayCharge(24 * 60)
  const fullDay = rate.capPaise ? Math.min(full.p, rate.capPaise) : full.p
  if (days) { lines.push({ label: `${days} × full day (24h${rate.capPaise ? ', capped' : ''})`, paise: days * fullDay }); total += days * fullDay }
  // After whole days, the remaining time is a fresh period with its own cap.
  if (rest > 0) {
    if (days && rest <= graceMin) rest = 0
  }
  if (rest > 0) {
    const d = dayCharge(rest)
    lines.push({ label: `First ${rate.firstHours}h`, paise: rate.firstPaise })
    if (d.extra) lines.push({ label: `${d.extra} extra hour${d.extra > 1 ? 's' : ''} × ${rupees(rate.perHourPaise)}`, paise: d.extra * rate.perHourPaise })
    if (rate.capPaise && d.p > rate.capPaise) lines.push({ label: `Daily cap ${rupees(rate.capPaise)} applied`, paise: rate.capPaise - d.p })
    total += rate.capPaise ? Math.min(d.p, rate.capPaise) : d.p
  }
  return { lines, total, hours: Math.ceil(minutes / 60), inGrace: false }
}

/** Price of a prepaid block of `hours` (pay at entry). */
export function prepaidPrice(hours: number, rate: Rate) {
  return charge(hours * 60, rate, 0).total
}

/** Minutes to drive out after paying online, before the stay is billed again. */
export const PAID_LEAVE_MIN = 5

export function billFor(db: DB, t: Ticket, at: number): Bill {
  const tv = db.tariffs.find(x => x.id === t.tariffId)!
  const rate = tv.rates[t.category]
  // Paid online before reaching the exit: the next PAID_LEAVE_MIN minutes cost nothing more (time to drive out).
  // Later than that, the stay is billed again for the real time and only the difference is due at the exit.
  const lastOnline = t.status === 'inside' ? Math.max(0, ...db.payments.filter(p => p.ticketId === t.id && p.kind === 'exit').map(p => p.at)) : 0
  const billAt = lastOnline && at >= lastOnline && at - lastOnline <= PAID_LEAVE_MIN * MIN ? lastOnline : at
  const minutes = Math.floor(((t.billedAt ?? t.onlineCheckout?.billedAt ?? t.exitAt ?? billAt) - t.entryAt) / MIN)
  const c = charge(minutes, rate, tv.graceMin)
  const prepaid = db.payments.filter(p => p.ticketId === t.id && p.kind === 'prepaid').reduce((s, p) => s + p.amountPaise, 0)
  const paidExit = db.payments.filter(p => p.ticketId === t.id && p.kind === 'exit').reduce((s, p) => s + p.amountPaise, 0)
  // Pay at entry: the customer always pays at least the block they chose, even if they leave early.
  const lines = [...c.lines]
  // Designated free vehicles: frozen on the ticket once billed, otherwise looked up by plate now.
  const freeVehicle = t.free ? undefined : freeVehicleFor(db, t.plate)
  const free = t.free ?? (freeVehicle && c.total > 0 ? { reason: freeVehicle.reason, waivedPaise: Math.max(0, c.total - prepaid) } : undefined)
  if (free) {
    lines.push({ label: `Free vehicle · ${free.reason}`, paise: -free.waivedPaise })
    if (prepaid) lines.push({ label: 'Paid at entry', paise: -prepaid })
    return { minutes, chargedHours: c.hours, lines, totalPaise: prepaid, prepaidPaise: prepaid, duePaise: 0, inGrace: c.inGrace, free }
  }
  const total = Math.max(c.total, prepaid)
  if (prepaid && c.total < prepaid) lines.push({ label: 'Minimum: prepaid block', paise: prepaid - c.total })
  if (prepaid) lines.push({ label: 'Paid at entry', paise: -prepaid })
  return { minutes, chargedHours: c.hours, lines, totalPaise: total, prepaidPaise: prepaid, duePaise: Math.max(0, total - prepaid - paidExit), inGrace: c.inGrace }
}

// ---------- storage ----------
const uid = () => Math.random().toString(36).slice(2, 10)
function token() {
  const b = new Uint8Array(16); crypto.getRandomValues(b)
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

export function seed(withHistory = true): DB {
  const now = Date.now()
  const rates: Record<string, Rate> = {
    bike: { firstHours: 2, firstPaise: 1000, perHourPaise: 1000, capPaise: 10000 },
    auto: { firstHours: 2, firstPaise: 2000, perHourPaise: 1000, capPaise: 15000 },
    car: { firstHours: 2, firstPaise: 3000, perHourPaise: 2000, capPaise: 30000 },
    suv: { firstHours: 2, firstPaise: 4000, perHourPaise: 2500, capPaise: 35000 },
    van: { firstHours: 2, firstPaise: 5000, perHourPaise: 3000, capPaise: 40000 },
    truck: { firstHours: 2, firstPaise: 10000, perHourPaise: 5000, capPaise: 80000 },
  }
  const db: DB = {
    seq: 100,
    staff: [
      { id: 'ravi', name: 'Ravi (Entry gate)', role: 'attendant', gate: 'Gate 1 Entry' },
      { id: 'sunil', name: 'Sunil (Exit gate)', role: 'attendant', gate: 'Gate 2 Exit' },
      { id: 'owner', name: 'Owner', role: 'owner', gate: 'Office' },
    ],
    categories: [
      { id: 'bike', name: 'Two-wheeler', icon: 'bike', active: true },
      { id: 'auto', name: 'Auto-rickshaw', icon: 'auto', active: true },
      { id: 'car', name: 'Car', icon: 'car', active: true },
      { id: 'suv', name: 'SUV', icon: 'suv', active: true },
      { id: 'van', name: 'Van', icon: 'van', active: true },
      { id: 'truck', name: 'Truck', icon: 'truck', active: true },
    ],
    tariffs: [{ id: 'tv1', version: 1, createdAt: now - 10 * 24 * HOUR, createdBy: 'Owner', note: 'Initial rates · verify before opening', graceMin: 5, rates }],
    settings: { siteName: 'City Centre Parking', operator: 'Your Parking Co.', address: 'Pune, Maharashtra', phone: '+91 00000 00000', payAtEntry: false, cancelNeedsReason: false, capacity: 500 },
    tickets: [], payments: [], audit: [],
  }
  if (withHistory) sampleHistory(db, now)
  return db
}

/** Seven days of believable traffic so the dashboard has something to show. Marked as sample in the audit. */
function sampleHistory(db: DB, now: number) {
  const plates = ['MH12AB', 'MH14CD', 'MH12KL', 'KA01MN', 'MH12PQ', 'GJ05RS', 'MH43TU', 'DL3CVW']
  const cats = ['car', 'car', 'car', 'bike', 'bike', 'bike', 'suv', 'auto', 'van', 'truck']
  let r = 7
  const rnd = () => (r = (r * 9301 + 49297) % 233280) / 233280
  for (let d = 6; d >= 0; d--) {
    const dayStart = new Date(istDay(now - d * 24 * HOUR) + 'T00:00:00+05:30').getTime()
    const n = 25 + Math.floor(rnd() * 30)
    for (let i = 0; i < n; i++) {
      const entryAt = dayStart + (7 + rnd() * 14) * HOUR
      if (entryAt > now - 20 * MIN) continue
      const stay = (10 + rnd() * rnd() * 420) * MIN
      const cat = cats[Math.floor(rnd() * cats.length)]
      const plate = plates[Math.floor(rnd() * plates.length)] + String(1000 + Math.floor(rnd() * 8999))
      const t = newTicket(db, plate, cat, 'ravi', entryAt, 0)
      db.audit.push({ id: uid(), at: entryAt, by: 'Ravi (Entry gate)', kind: 'entry', ticketId: t.id, text: `Sample entry ${prettyPlate(plate)}` })
      const exitAt = entryAt + stay
      if (exitAt < now && rnd() > 0.04) {
        const b = billFor(db, { ...t, exitAt }, exitAt)
        if (b.duePaise) addPayment(db, t, b.duePaise, 'sunil', exitAt - MIN, 'exit')
        Object.assign(t, { status: 'exited', exitAt, exitGate: 'Gate 2 Exit', exitBy: 'Sunil (Exit gate)', billedAt: exitAt, totalPaise: b.totalPaise })
        db.audit.push({ id: uid(), at: exitAt, by: 'Sunil (Exit gate)', kind: 'exit', ticketId: t.id, text: `Sample exit, ${rupees(b.totalPaise)}`, amountPaise: b.totalPaise })
      } else if (exitAt < now) {
        Object.assign(t, { status: 'cancelled', cancelledAt: entryAt + 2 * MIN, cancelledBy: 'Ravi (Entry gate)' })
        db.audit.push({ id: uid(), at: entryAt + 2 * MIN, by: 'Ravi (Entry gate)', kind: 'cancel', ticketId: t.id, text: 'Sample cancel (wrong vehicle type)' })
      }
    }
  }
}

function newTicket(db: DB, plate: string, category: string, staffId: string, at: number, prepaidHours: number): Ticket {
  const s = db.staff.find(x => x.id === staffId)!
  const tv = activeTariff(db, at)
  const t: Ticket = {
    id: 'T-' + String(++db.seq).padStart(6, '0'), token: token(), plate: normPlate(plate), category,
    site: db.settings.siteName, entryGate: s.gate, entryBy: s.name, entryAt: at, tariffId: tv.id,
    prepaidHours, status: 'inside', prints: 0, rev: 1,
  }
  db.tickets.push(t)
  return t
}
function addPayment(db: DB, t: Ticket, amountPaise: number, staffId: string, at: number, kind: Payment['kind'], method: Payment['method'] = 'cash') {
  const s = db.staff.find(x => x.id === staffId)!
  const p: Payment = { id: uid(), ticketId: t.id, amountPaise, method, at, by: s.name, kind, receiptNo: 'R-' + String(db.payments.length + 1).padStart(6, '0') }
  db.payments.push(p)
  return p
}

export function activeTariff(db: DB, at = Date.now()) {
  return [...db.tariffs].filter(t => t.createdAt <= at).sort((a, b) => b.version - a.version)[0] ?? db.tariffs[0]
}

/** Money the customer already paid on their phone for this stay (still inside). */
export const paidOnPhone = (db: DB, t: Ticket) => db.payments.filter(p => p.ticketId === t.id && p.kind === 'exit').reduce((sum, p) => sum + p.amountPaise, 0)

/** Until when the money already paid covers the stay (the next charged hour starts after this). */
export function paidUntil(db: DB, t: Ticket, paidPaise: number) {
  const tv = db.tariffs.find(x => x.id === t.tariffId)
  const rate = tv?.rates[t.category]
  if (!tv || !rate || paidPaise <= 0) return undefined
  let hours = 0
  while (hours < 24 * 7 && charge((hours + 1) * 60, rate, tv.graceMin).total <= paidPaise) hours++
  // Covered to the end of the paid hours, and always at least PAID_LEAVE_MIN minutes after the last online payment.
  const lastOnline = Math.max(0, ...db.payments.filter(p => p.ticketId === t.id && p.kind === 'exit').map(p => p.at))
  const end = Math.max(hours > 0 ? t.entryAt + hours * 60 * MIN : 0, lastOnline ? lastOnline + PAID_LEAVE_MIN * MIN : 0)
  return end || undefined
}

export const freeVehicleFor = (db: DB, plate: string) => (db.freeVehicles ?? []).find(v => v.active && v.plate === normPlate(plate))

/** Freeze the receipt exactly as it will be printed. Called when the bill is paid. */
export function makeReceipt(db: DB, t: Ticket, by: string): Receipt {
  const b = billFor(db, t, t.billedAt ?? Date.now())
  const pays = db.payments.filter(p => p.ticketId === t.id)
  const last = pays[pays.length - 1]
  return {
    receiptNo: last?.receiptNo ?? 'R-' + t.id.slice(2), issuedAt: Date.now(), issuedBy: by,
    operator: db.settings.operator, siteName: db.settings.siteName, address: db.settings.address, phone: db.settings.phone, ...(db.settings.gstin ? { gstin: db.settings.gstin } : {}),
    ticketId: t.id, plate: t.plate, vehicle: db.categories.find(c => c.id === t.category)?.name ?? t.category, entryAt: t.entryAt, entryGate: t.entryGate,
    billedAt: t.billedAt ?? Date.now(), minutes: b.minutes, lines: b.lines, totalPaise: t.totalPaise ?? b.totalPaise,
    payments: pays.map(p => ({ method: p.method, kind: p.kind, amountPaise: p.amountPaise, receiptNo: p.receiptNo, ...(p.by === 'Customer (phone)' ? { phone: true, at: p.at } : {}) })),
    free: t.free,
  }
}

export function load(): DB {
  try { const s = localStorage.getItem(KEY); if (s) return JSON.parse(s) } catch { /* fall through */ }
  const db = seed(false); save(db); return db
}
export function save(db: DB) { try { localStorage.setItem(KEY, JSON.stringify(db)) } catch { /* demo only */ } }
export function reset() { const db = seed(); save(db); return db }

// ---------- actions (each one is a "server call": re-reads, checks, writes, audits) ----------
export class Refused extends Error {}
export function runAction<A extends unknown[], R>(db: DB, staffId: string, action: (db: DB, staff: Staff, ...args: A) => R, ...args: A): R {
  const staff = db.staff.find(person => person.id === staffId)
  if (!staff) throw new Refused('Unknown device role')
  return action(db, staff, ...args)
}

const log = (db: DB, s: Staff, kind: AuditKind, text: string, ticketId?: string, amountPaise?: number) =>
  db.audit.push({ id: uid(), at: Date.now(), by: s.name, kind, text, ticketId, amountPaise })

export const findActiveByPlate = (db: DB, plate: string) => db.tickets.find(t => t.plate === normPlate(plate) && (t.status === 'inside' || t.status === 'paid'))

/** Create the entry. If the plate is already inside, return that ticket instead of making a second one. */
export const createEntry = (db: DB, s: Staff, plate: string, category: string, prepaidHours: number, plateNote?: string, expectedPrepaidPaise?: number | null) => {
  const normalized = normPlate(plate)
  if (normalized.length < 4 || normalized.length > 20) throw new Refused('Check the vehicle number.')
  const existing = findActiveByPlate(db, normalized)
  if (existing) { log(db, s, 'duplicate_blocked', `Second entry blocked for ${prettyPlate(plate)}; existing ticket shown`, existing.id); return { ticket: existing, duplicate: true } }
  if (!isSupportedPlateFormat(normalized)) throw new Refused('Enter a supported Indian registration format, such as GA 01 AB 1234.')
  if (!db.categories.some(item => item.id === category && item.active) || !Object.hasOwn(activeTariff(db).rates, category)) throw new Refused('Select an available vehicle type.')
  if (!Number.isInteger(prepaidHours) || prepaidHours < 0 || prepaidHours > 24 || (!db.settings.payAtEntry && prepaidHours > 0)) throw new Refused('Check the prepaid hours and payment settings.')
  const now = Date.now()
  const advance = prepaidHours ? prepaidPrice(prepaidHours, activeTariff(db, now).rates[category]) : 0
  if (expectedPrepaidPaise != null && advance !== expectedPrepaidPaise) throw new Refused('The advance amount changed. Check the updated amount before saving.')
  const t = newTicket(db, plate, category, s.id, now, prepaidHours)
  t.entryBy = s.name
  log(db, s, 'entry', `Entry ${prettyPlate(t.plate)} · ${db.categories.find(c => c.id === category)?.name}${plateNote ? ` · ${plateNote}` : ''}`, t.id)
  if (prepaidHours) {
    const amt = advance
    addPayment(db, t, amt, s.id, now, 'prepaid').by = s.name
    log(db, s, 'payment', `Cash ${rupees(amt)} at entry for ${prepaidHours}h`, t.id, amt)
  }
  return { ticket: t, duplicate: false }
}

/** Log a print. `what` is the entry slip (default, for older devices) or the exit receipt. */
export const markPrinted = (db: DB, s: Staff, id: string, what?: 'slip' | 'receipt' | null) => {
  const t = db.tickets.find(x => x.id === id)
  if (!t) throw new Refused('Ticket not found.')
  if (what === 'receipt') {
    if (!t.receipt && t.status !== 'paid' && t.status !== 'exited') throw new Refused('There is no receipt yet. Take payment first.')
    t.receiptPrints = (t.receiptPrints ?? 0) + 1
    const n = t.receiptPrints
    log(db, s, n > 1 ? 'receipt_reprint' : 'receipt_print', n > 1 ? `Reprint #${n - 1} of receipt` : 'Receipt printed', id)
    return n
  }
  t.prints++
  log(db, s, t.prints > 1 ? 'reprint' : 'print', t.prints > 1 ? `Reprint #${t.prints - 1} of slip` : 'Slip printed', id)
  return t.prints
}

export function findTicketBySlip(tickets: Ticket[], input: string): Ticket | undefined {
  const value = input.trim()
  if (!value) return undefined

  const route = /#\/t\/([^/?#]+)$/i.exec(value)
  const token = route?.[1] ?? value
  const number = /^(?:T-?)?(\d+)$/i.exec(value)?.[1]
  const id = number ? 'T-' + number.padStart(6, '0') : undefined
  return tickets.find(ticket => ticket.token === token || ticket.id === id)
}

export const logLookup = (db: DB, s: Staff, id: string, how: 'plate' | 'qr' | 'search') => {
  log(db, s, how === 'qr' ? 'lookup_qr' : 'lookup_plate', how === 'qr' ? 'Opened by ticket QR / ID' : `Found by plate (${how === 'plate' ? 'slip not used' : 'search'})`, id)
}

/** Take cash for what is due now. `rev` must match, so two attendants cannot both collect. */
export const takeCash = (db: DB, s: Staff, id: string, rev: number, expectedPaise: number) => {
  const t = db.tickets.find(x => x.id === id)
  if (!t) throw new Refused('Ticket not found.')
  if (t.status !== 'inside') throw new Refused(t.status === 'paid' ? 'Already paid. Another attendant collected this.' : `Ticket is ${t.status}.`)
  if (t.onlineCheckout) throw new Refused('An online order is open. Resume online checkout or check payment before letting the vehicle leave.')
  if (t.rev !== rev) throw new Refused('This ticket changed on another device. Reload it.')
  const now = Date.now()
  const b = billFor(db, t, now)
  if (b.duePaise !== expectedPaise) throw new Refused(`Amount changed to ${rupees(b.duePaise)} (time moved on). Check and try again.`)
  if (b.duePaise) addPayment(db, t, b.duePaise, s.id, now, 'exit').by = s.name
  t.status = 'paid'; t.billedAt = now; t.totalPaise = b.totalPaise; t.rev++
  if (b.free) t.free = b.free
  t.receipt = makeReceipt(db, t, s.name)
  const online = paidOnPhone(db, t)
  log(db, s, 'payment', b.free ? `Free vehicle (${b.free.reason}) · ${rupees(b.free.waivedPaise)} waived` : b.duePaise ? `Cash ${rupees(b.duePaise)} received${online ? ' (extra time after paying on phone)' : ''}` : online ? `Paid on phone · nothing more due` : 'Nothing due', id, b.duePaise)
  return t
}

export function settleOnlinePayment(db: DB, staff: Staff, ticket: Ticket, orderId: string, paymentId: string) {
  const order = ticket.onlineCheckout
  if (!order || order.orderId !== orderId) throw new Refused('The payment does not match this ticket.')
  // The operator already confirmed this UPI payment: Razorpay's confirmation just completes the record.
  if (ticket.upiCheck && ticket.upiCheck.orderId === orderId && (ticket.status === 'paid' || ticket.status === 'exited')) {
    const pending = db.payments.find(p => p.ticketId === ticket.id && p.method === 'razorpay' && !p.providerPaymentId)
    if (pending) pending.providerPaymentId = paymentId
    delete ticket.upiCheck
    ticket.rev++
    log(db, staff, 'payment', `Razorpay confirmed the UPI payment of ${rupees(order.amount)}`, ticket.id, 0)
    return ticket
  }
  const previous = db.payments.find(payment => payment.providerPaymentId === paymentId)
  if (previous?.ticketId === ticket.id && (ticket.status === 'paid' || ticket.status === 'exited' || order.byCustomer)) return ticket
  if (previous || ticket.status !== 'inside') throw new Refused('This ticket cannot accept another payment.')

  const now = Date.now()
  // Paid on the customer's phone before reaching the gate: the money is recorded and the vehicle stays "inside".
  // At the exit the bill is worked out again for the real time; anything still due (a longer stay) is collected there.
  if (order.byCustomer) {
    const payment = addPayment(db, ticket, order.amount, staff.id, now, 'exit', 'razorpay')
    payment.by = 'Customer (phone)'
    payment.providerPaymentId = paymentId
    delete ticket.onlineCheckout
    ticket.rev++
    log(db, staff, 'payment', `Customer paid ${rupees(order.amount)} on their phone (Razorpay) · receipt at the exit`, ticket.id, order.amount)
    return ticket
  }
  const payment = addPayment(db, ticket, order.amount, staff.id, now, 'exit', 'razorpay')
  payment.by = staff.name
  payment.providerPaymentId = paymentId
  ticket.status = 'paid'
  ticket.billedAt = order.billedAt
  ticket.totalPaise = order.totalPaise
  ticket.rev++
  ticket.receipt = makeReceipt(db, ticket, staff.name)
  log(db, staff, 'payment', `Razorpay ${rupees(order.amount)} received`, ticket.id, order.amount)
  return ticket
}

/** The operator saw the customer's UPI app say "paid": complete the exit now; the server confirms with Razorpay in the background. */
export const confirmUpiByOperator = (db: DB, s: Staff, id: string, rev: number) => {
  const t = db.tickets.find(x => x.id === id)
  if (!t) throw new Refused('Ticket not found.')
  if (t.status !== 'inside') throw new Refused(t.status === 'paid' ? 'Already paid.' : `Ticket is ${t.status}.`)
  const order = t.onlineCheckout
  if (!order) throw new Refused('There is no UPI QR open for this ticket.')
  if (t.rev !== rev) throw new Refused('This ticket changed on another device. Reload it.')
  const now = Date.now()
  addPayment(db, t, order.amount, s.id, now, 'exit', 'razorpay').by = s.name
  t.upiCheck = { orderId: order.orderId, amount: order.amount, at: now, by: s.name }
  t.status = 'paid'; t.billedAt = order.billedAt; t.totalPaise = order.totalPaise; t.rev++
  t.receipt = makeReceipt(db, t, s.name)
  log(db, s, 'payment', `UPI ${rupees(order.amount)} confirmed by the operator (customer's app showed paid) · Razorpay confirms in the background`, id, order.amount)
  return t
}

export const recordExit = (db: DB, s: Staff, id: string) => {
  const t = db.tickets.find(x => x.id === id)
  if (!t) throw new Refused('Ticket not found.')
  if (t.status !== 'paid') throw new Refused(t.status === 'exited' ? 'Vehicle already marked as left.' : 'Take payment first.')
  t.status = 'exited'; t.exitAt = Date.now(); t.exitBy = s.name; t.exitGate = s.gate; t.rev++
  log(db, s, 'exit', `Vehicle left · ${rupees(t.totalPaise ?? 0)}`, id, t.totalPaise)
  return t
}

export const cancelTicket = (db: DB, s: Staff, id: string, reason: string) => {
  const t = db.tickets.find(x => x.id === id)
  if (!t) throw new Refused('Ticket not found.')
  if (t.status === 'exited' || t.status === 'cancelled') throw new Refused(`Ticket is already ${t.status}.`)
  if (t.onlineCheckout) throw new Refused('This ticket has an online order. Reconcile it before cancelling.')
  if (db.settings.cancelNeedsReason && !reason.trim()) throw new Refused('A reason is required (Owner setting).')
  t.status = 'cancelled'; t.cancelledAt = Date.now(); t.cancelledBy = s.name; t.cancelReason = reason; t.rev++
  log(db, s, 'cancel', `Cancelled${reason ? `: ${reason}` : ' (no reason)'}`, id)
}

export const publishTariff = (db: DB, s: Staff, graceMin: number, rates: Record<string, Rate>, note: string) => {
  if (s.role !== 'owner') throw new Refused('Only the Owner can change rates.')
  const v = Math.max(...db.tariffs.map(t => t.version)) + 1
  db.tariffs.push({ id: 'tv' + v, version: v, createdAt: Date.now(), createdBy: s.name, note, graceMin, rates })
  log(db, s, 'tariff', `Published rates v${v}${note ? `: ${note}` : ''}. Vehicles already inside keep their entry rates.`)
}

export const saveSettings = (db: DB, s: Staff, next: Settings) => {
  if (s.role !== 'owner') throw new Refused('Only the Owner can change settings.')
  const changed = (Object.keys(next) as (keyof Settings)[]).filter(k => next[k] !== db.settings[k])
  db.settings = next
  if (changed.length) log(db, s, 'settings', `Changed: ${changed.join(', ')}`)
}

export const byToken = (db: DB, tk: string) => db.tickets.find(t => t.token === tk)

/** Owner: let a vehicle park free (staff, police, ambulance…). Every change is in the master audit. */
export const addFreeVehicle = (db: DB, s: Staff, plate: string, reason: string, note?: string | null) => {
  if (s.role !== 'owner') throw new Refused('Only the Owner can manage free vehicles.')
  const p = normPlate(plate)
  if (!isSupportedPlateFormat(p)) throw new Refused('Enter a supported Indian registration format, such as GA 01 AB 1234.')
  const why = reason.trim().slice(0, 60)
  if (!why) throw new Refused('Choose why this vehicle parks free.')
  db.freeVehicles ??= []
  const existing = freeVehicleFor(db, p)
  if (existing) { existing.reason = why; existing.note = note?.trim() || undefined }
  else db.freeVehicles.push({ plate: p, reason: why, note: note?.trim() || undefined, addedAt: Date.now(), addedBy: s.name, active: true })
  log(db, s, 'free_vehicle', `${existing ? 'Updated' : 'Added'} free vehicle ${prettyPlate(p)} · ${why}`)
}

export const removeFreeVehicle = (db: DB, s: Staff, plate: string) => {
  if (s.role !== 'owner') throw new Refused('Only the Owner can manage free vehicles.')
  const v = freeVehicleFor(db, plate)
  if (!v) throw new Refused('That vehicle is not on the free list.')
  v.active = false; v.removedAt = Date.now(); v.removedBy = s.name
  log(db, s, 'free_vehicle', `Removed free vehicle ${prettyPlate(v.plate)} · was ${v.reason}`)
}
