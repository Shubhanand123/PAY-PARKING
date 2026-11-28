// Reports and export (step 5, 28 Nov 2026). Every report is built from the records by this one file,
// on the Owner's screen and on the server alike, so a CSV, the printed PDF and the verify page always agree.
//  * Date range: whole India days, from and to included.
//  * CSV: amounts in rupees with 2 decimals (spreadsheets read them as numbers).
//  * Printed PDF: letterhead + a check code. The server keeps the code with the report's totals and a SHA-256
//    fingerprint of its CSV; anyone can type the code on the public verify page (#/verify) to see they match.
//  * Personal details from complaints (name, mobile, message) are never put in an export.

import { COMPLAINT_TYPES, STATUS_LABEL } from './complaints.ts'
import { dur, fmtDT, istDay, log, prettyPlate, Refused, rupees, type DB, type Staff } from './engine.ts'

export const REPORTS = {
  tickets: 'Tickets',
  payments: 'Payments & GST',
  vehicles: 'Vehicles',
  closes: 'Day closing',
  complaints: 'Complaints & feedback',
  audit: 'Activity log',
} as const
export type ReportType = keyof typeof REPORTS

export type Report = {
  type: ReportType; title: string; from: string; to: string
  columns: string[]; rows: string[][]
  totals: [string, string][]
  note?: string
}
export type IssuedReport = { code: string; type: ReportType; from: string; to: string; at: number; by: string; rows: number; totals: [string, string][]; digest: string }

/** GST on parking (SAC 9967), 18% = 9% CGST + 9% SGST inside Goa. Prices already include it. */
export const GST_RATE = 18
export function gstSplit(paise: number) {
  const taxable = Math.round(paise * 100 / (100 + GST_RATE))
  const tax = paise - taxable
  const cgst = Math.floor(tax / 2)
  return { taxable, cgst, sgst: tax - cgst }
}

const money = (p: number) => (p / 100).toFixed(2)
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
export const validDay = (d: unknown): d is string => typeof d === 'string' && DAY_RE.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00+05:30'))
const inRange = (from: string, to: string) => (t: number | undefined) => t != null && istDay(t) >= from && istDay(t) <= to
const METHOD = { cash: 'Cash', razorpay: 'Online (Razorpay)' }

export function buildReport(db: DB, type: ReportType, from: string, to: string): Report {
  if (!Object.hasOwn(REPORTS, type)) throw new Refused('Choose a report.')
  if (!validDay(from) || !validDay(to) || from > to) throw new Refused('Choose a valid date range.')
  if (Date.parse(to) - Date.parse(from) > 400 * 86400_000) throw new Refused('Choose at most 13 months at a time.')
  const inside = inRange(from, to)
  const cat = (id: string) => db.categories.find(c => c.id === id)?.name ?? id
  const base = { type, title: REPORTS[type], from, to }

  if (type === 'tickets') {
    const list = db.tickets.filter(t => inside(t.entryAt))
    const amount = list.reduce((s, t) => s + (t.status === 'cancelled' ? 0 : t.totalPaise ?? 0), 0)
    return {
      ...base,
      columns: ['Ticket no.', 'Vehicle no.', 'Type', 'Entry', 'Entry gate', 'Exit', 'Status', 'Time parked', 'Amount (₹)', 'Slip prints', 'Receipt no.'],
      rows: list.map(t => [t.id, prettyPlate(t.plate), cat(t.category), fmtDT(t.entryAt), t.entryGate, t.exitAt ? fmtDT(t.exitAt) : '',
        t.status === 'exited' ? 'Left' : t.status === 'paid' ? 'Paid, not left' : t.status === 'inside' ? 'Inside' : 'Cancelled' + (t.cancelReason ? ': ' + t.cancelReason : ''),
        t.exitAt ? dur(t.exitAt - t.entryAt) : '', t.totalPaise != null && t.status !== 'cancelled' ? money(t.totalPaise) : '', String(t.prints), t.receipt?.receiptNo ?? '']),
      totals: [['Tickets', String(list.length)], ['Left', String(list.filter(t => t.status === 'exited').length)], ['Cancelled', String(list.filter(t => t.status === 'cancelled').length)], ['Billed', rupees(amount)]],
    }
  }

  if (type === 'payments') {
    const list = db.payments.filter(p => inside(p.at)).sort((a, b) => a.at - b.at)
    const gst = Boolean(db.settings.gstin)
    const sum = (f: (p: typeof list[number]) => boolean) => list.filter(f).reduce((s, p) => s + p.amountPaise, 0)
    const total = sum(() => true)
    const split = list.reduce((a, p) => { const g = gstSplit(p.amountPaise); return { taxable: a.taxable + g.taxable, cgst: a.cgst + g.cgst, sgst: a.sgst + g.sgst } }, { taxable: 0, cgst: 0, sgst: 0 })
    const plate = (id: string) => { const t = db.tickets.find(x => x.id === id); return t ? prettyPlate(t.plate) : '' }
    return {
      ...base,
      columns: ['Receipt no.', 'Date & time', 'Ticket no.', 'Vehicle no.', 'Paid by', 'When', 'Amount (₹)', ...(gst ? [`Taxable (₹)`, `CGST 9% (₹)`, `SGST 9% (₹)`] : []), 'Razorpay payment id', 'Collected by'],
      rows: list.map(p => { const g = gstSplit(p.amountPaise); return [p.receiptNo, fmtDT(p.at), p.ticketId, plate(p.ticketId), METHOD[p.method], p.kind === 'prepaid' ? 'At entry' : 'At exit',
        money(p.amountPaise), ...(gst ? [money(g.taxable), money(g.cgst), money(g.sgst)] : []), p.providerPaymentId ?? '', p.by] }),
      totals: [['Payments', String(list.length)], ['Cash', rupees(sum(p => p.method === 'cash'))], ['Online', rupees(sum(p => p.method === 'razorpay'))], ['Total', rupees(total)],
        ...(gst ? [['Taxable value', rupees(split.taxable)], ['CGST', rupees(split.cgst)], ['SGST', rupees(split.sgst)]] as [string, string][] : [])],
      note: gst ? `GSTIN ${db.settings.gstin}. Parking charges include GST at ${GST_RATE}% (CGST 9% + SGST 9%), SAC 9967.` : 'No GSTIN in Settings, so no GST split is shown.',
    }
  }

  if (type === 'vehicles') {
    const by = new Map<string, { plate: string; types: Set<string>; visits: number; ms: number; paise: number; first: number; last: number }>()
    for (const t of db.tickets.filter(x => inside(x.entryAt) && x.status !== 'cancelled')) {
      const v = by.get(t.plate) ?? { plate: t.plate, types: new Set<string>(), visits: 0, ms: 0, paise: 0, first: t.entryAt, last: t.entryAt }
      v.types.add(cat(t.category)); v.visits++; v.ms += (t.exitAt ?? t.billedAt ?? t.entryAt) - t.entryAt; v.paise += t.totalPaise ?? 0
      v.first = Math.min(v.first, t.entryAt); v.last = Math.max(v.last, t.entryAt)
      by.set(t.plate, v)
    }
    const list = [...by.values()].sort((a, b) => b.visits - a.visits || b.paise - a.paise)
    const free = (p: string) => (db.freeVehicles ?? []).find(f => f.active && f.plate === p)?.reason ?? ''
    return {
      ...base,
      columns: ['Vehicle no.', 'Type', 'Visits', 'Time parked', 'Paid (₹)', 'First visit', 'Last visit', 'Free vehicle'],
      rows: list.map(v => [prettyPlate(v.plate), [...v.types].join(', '), String(v.visits), dur(v.ms), money(v.paise), fmtDT(v.first), fmtDT(v.last), free(v.plate)]),
      totals: [['Vehicles', String(list.length)], ['Visits', String(list.reduce((s, v) => s + v.visits, 0))], ['Came back (2+ visits)', String(list.filter(v => v.visits > 1).length)]],
    }
  }

  if (type === 'closes') {
    const list = (db.cashCloses ?? []).filter(c => inside(c.at))
    return {
      ...base,
      columns: ['Close no.', 'Closed at', 'Covers from', 'Cash expected (₹)', 'Cash counted (₹)', 'Difference (₹)', 'Note', 'Online (₹)', 'Cash payments', 'Sent late', 'Closed by'],
      rows: list.map(c => [String(c.no), fmtDT(c.at), fmtDT(c.from), money(c.expectedPaise), money(c.countedPaise), money(c.diffPaise), c.note ?? '', money(c.onlinePaise), String(c.cashPayments), String(c.late), c.by]),
      totals: [['Closes', String(list.length)], ['Cash expected', rupees(list.reduce((s, c) => s + c.expectedPaise, 0))], ['Cash counted', rupees(list.reduce((s, c) => s + c.countedPaise, 0))],
        ['Difference', rupees(list.reduce((s, c) => s + c.diffPaise, 0))]],
    }
  }

  if (type === 'complaints') {
    const list = (db.complaints ?? []).filter(c => inside(c.at))
    const ratings = (db.ratings ?? []).filter(r => inside(r.at))
    const rating = (id: string) => ratings.find(r => r.ticketId === id)?.score
    const hours = (a?: number, b?: number) => a && b ? ((b - a) / 3600_000).toFixed(1) : ''
    const avg = ratings.length ? (ratings.reduce((s, r) => s + r.score, 0) / ratings.length).toFixed(1) : '–'
    return {
      ...base,
      columns: ['Complaint no.', 'Received', 'Ticket no.', 'About', 'Status', 'Hours to first reply', 'Hours to resolve', 'Photos', 'Messages', 'Rating (1–5)'],
      rows: list.map(c => [c.id, fmtDT(c.at), c.ticketId, COMPLAINT_TYPES[c.type], STATUS_LABEL[c.status], hours(c.at, c.firstReplyAt), hours(c.at, c.resolvedAt), String(c.photos.length), String(c.messages.length), String(rating(c.ticketId) ?? '')]),
      totals: [['Complaints', String(list.length)], ['Still open', String(list.filter(c => c.status === 'new' || c.status === 'open').length)], ['Ratings', String(ratings.length)], ['Average rating', avg]],
      note: 'Names, mobile numbers and messages are not included in exports (privacy).',
    }
  }

  const list = db.audit.filter(a => inside(a.at))
  return {
    ...base,
    columns: ['Time', 'By', 'What', 'Ticket no.', 'Details', 'Amount (₹)'],
    rows: list.map(a => [fmtDT(a.at), a.by, a.kind, a.ticketId ?? '', a.text, a.amountPaise != null ? money(a.amountPaise) : '']),
    totals: [['Entries', String(list.length)], ['Cancellations', String(list.filter(a => a.kind === 'cancel').length)], ['Reprints', String(list.filter(a => a.kind === 'reprint' || a.kind === 'receipt_reprint').length)]],
  }
}

const cell = (raw: string) => { const v = /^[=+@\t]/.test(raw) || /^-(?!\d)/.test(raw) ? "'" + raw : raw; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v }
/** CSV text (with a BOM so Excel shows ₹ correctly). Cells starting with = + - @ cannot run as formulas. */
export function toCsv(r: Report) {
  return '﻿' + [r.columns, ...r.rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

export async function sha256(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function newCheckCode() {
  const r = crypto.getRandomValues(new Uint8Array(8))
  const s = Array.from(r, b => CODE_LETTERS[b % CODE_LETTERS.length]).join('')
  return s.slice(0, 4) + '-' + s.slice(4)
}
export const readCheckCode = (v: string) => { const s = v.toUpperCase().replace(/[^A-Z0-9]/g, ''); return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4) : '' }

/** Record a printed report so its check code can be verified later. The caller builds the report and its fingerprint. */
export const issueReport = (db: DB, s: Staff, type: ReportType, from: string, to: string, digest: string) => {
  if (s.role !== 'owner') throw new Refused('Only the Owner can issue reports.')
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Refused('Report fingerprint missing.')
  const r = buildReport(db, type, from, to)
  const reports = (db.reports ??= [])
  let code = newCheckCode()
  while (reports.some(x => x.code === code)) code = newCheckCode()
  const issued: IssuedReport = { code, type, from, to, at: Date.now(), by: s.name, rows: r.rows.length, totals: r.totals, digest }
  reports.push(issued)
  if (reports.length > 3000) db.reports = reports.slice(-3000)
  log(db, s, 'report', `Report printed: ${REPORTS[type]} ${from} to ${to} · ${r.rows.length} rows · check code ${code}`)
  return issued
}

/** Public verify page: what was issued under this code (no rows, only the totals). */
export function verifyReport(db: DB, code: string) {
  const c = readCheckCode(code)
  const r = c ? (db.reports ?? []).find(x => x.code === c) : undefined
  if (!r) return undefined
  return { ...r, title: REPORTS[r.type], operator: db.settings.operator, siteName: db.settings.siteName, gstin: db.settings.gstin }
}
export type VerifiedReport = NonNullable<ReturnType<typeof verifyReport>>
