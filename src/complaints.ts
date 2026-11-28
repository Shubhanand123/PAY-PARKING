// Feedback and complaints (step 7, 28 Nov 2026). The customer reaches them from the QR on the slip or receipt
// (the ticket page), so every complaint is tied to a real ticket and nobody needs an account.
//  * Smiley rating: one per ticket, can be changed.
//  * Complaint: name, mobile, type, message, up to 3 photos, consent. Number SKC-C-YYMM-NNN.
//    The customer follows it on the same ticket page and can write back; the Owner replies from the dashboard.
//  * Internal notes are for the Owner only and are never sent to the customer page.
//  * Privacy (DPDP Act 2023): data is used only to handle the complaint; a complaint is deleted with its photos
//    180 days after it is closed. Resolved complaints close by themselves after 7 days without a customer reply.
//    The activity log only ever records the complaint number and type, never the name, mobile or message.

import { complaintNumber } from './numbers.ts'
import { log, Refused, type DB, type Staff, type Ticket } from './engine.ts'

export const COMPLAINT_TYPES = {
  overcharge: 'Charged wrongly',
  payment: 'Payment problem',
  damage: 'Damage to vehicle',
  theft: 'Item missing / theft',
  staff: 'Staff behaviour',
  space: 'Space, cleanliness or lights',
  other: 'Something else',
} as const
export type ComplaintType = keyof typeof COMPLAINT_TYPES
export type ComplaintStatus = 'new' | 'open' | 'resolved' | 'closed'
export const STATUS_LABEL: Record<ComplaintStatus, string> = { new: 'New', open: 'In progress', resolved: 'Resolved', closed: 'Closed' }

export type ComplaintMessage = { at: number; from: 'customer' | 'owner'; text: string }
export type Complaint = {
  id: string                 // SKC-C-2611-012
  ticketId: string
  at: number
  name: string
  mobile: string             // 10 digits, Indian mobile
  type: ComplaintType
  message: string
  photos: string[]           // storage paths in the private "complaints" bucket (data: URLs in local mode)
  consentAt: number
  status: ComplaintStatus
  messages: ComplaintMessage[]  // the conversation the customer sees (after the first message)
  notes: { at: number; by: string; text: string }[] // Owner only
  firstReplyAt?: number
  resolvedAt?: number
  closedAt?: number
}
export type Rating = { ticketId: string; at: number; score: 1 | 2 | 3 | 4 | 5; comment?: string }

export const SMILEYS = [
  { score: 1, face: '😠', label: 'Very bad' },
  { score: 2, face: '🙁', label: 'Bad' },
  { score: 3, face: '😐', label: 'Okay' },
  { score: 4, face: '🙂', label: 'Good' },
  { score: 5, face: '😄', label: 'Excellent' },
] as const

export const MAX_PHOTOS = 3
export const RETENTION_DAYS = 180
export const AUTO_CLOSE_DAYS = 7
const DAY = 24 * 3600_000
const MAX_PER_TICKET = 3
const MAX_MESSAGES = 30
const customer: Staff = { id: 'customer', name: 'Customer (phone)', role: 'attendant', gate: 'Ticket page' }

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max)
export const normMobile = (v: string) => { const d = v.replace(/\D/g, ''); return d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d }
export const validMobile = (v: string) => /^[6-9]\d{9}$/.test(normMobile(v))

function ticketFor(db: DB, token: string) {
  const t = db.tickets.find(x => x.token === token)
  if (!t) throw new Refused('Ticket not found.')
  if (Date.now() - t.entryAt > 90 * DAY) throw new Refused('This ticket is more than 90 days old. Please call the parking office.')
  return t
}

/** Smiley rating from the ticket page. One per ticket; a second tap changes it. */
export const rateVisit = (db: DB, token: string, score: number, comment?: string | null) => {
  const t = ticketFor(db, token)
  if (![1, 2, 3, 4, 5].includes(score)) throw new Refused('Choose a smiley.')
  const ratings = (db.ratings ??= [])
  const old = ratings.find(r => r.ticketId === t.id)
  const r: Rating = { ticketId: t.id, at: Date.now(), score: score as Rating['score'], ...(clean(comment, 300) ? { comment: clean(comment, 300) } : {}) }
  if (old) Object.assign(old, r); else ratings.push(r)
  if (!old) log(db, customer, 'feedback', `Rating ${'★'.repeat(score)}${'☆'.repeat(5 - score)}`, t.id)
  return r
}

export type ComplaintInput = { name: string; mobile: string; type: string; message: string; consent: boolean }

/** Check a complaint before photos are uploaded (the server checks again when saving). */
export function checkComplaint(db: DB, token: string, input: ComplaintInput, photos = 0) {
  const t = ticketFor(db, token)
  const name = clean(input?.name, 60), message = clean(input?.message, 1500), mobile = normMobile(clean(input?.mobile, 20))
  if (name.length < 2) throw new Refused('Enter your name.')
  if (!validMobile(mobile)) throw new Refused('Enter a 10-digit Indian mobile number.')
  if (!Object.hasOwn(COMPLAINT_TYPES, input?.type)) throw new Refused('Choose what the complaint is about.')
  if (message.length < 5) throw new Refused('Tell us what happened.')
  if (input?.consent !== true) throw new Refused('Please tick the consent box so we can use your details to handle the complaint.')
  if (photos > MAX_PHOTOS) throw new Refused(`Add at most ${MAX_PHOTOS} photos.`)
  const open = (db.complaints ?? []).filter(c => c.ticketId === t.id)
  if (open.length >= MAX_PER_TICKET) throw new Refused('This ticket already has 3 complaints. Write on an existing complaint below.')
  return { t, name, mobile, message, type: input.type as ComplaintType }
}

export const addComplaint = (db: DB, token: string, input: ComplaintInput, photos: string[] = []) => {
  const { t, name, mobile, message, type } = checkComplaint(db, token, input, photos.length)
  const now = Date.now()
  db.cseq = (db.cseq ?? 0) + 1
  const c: Complaint = { id: complaintNumber(now, db.cseq), ticketId: t.id, at: now, name, mobile, type, message, photos: photos.slice(0, MAX_PHOTOS), consentAt: now, status: 'new', messages: [], notes: [] }
  ;(db.complaints ??= []).push(c)
  log(db, customer, 'complaint', `Complaint ${c.id} received · ${COMPLAINT_TYPES[type]}${photos.length ? ` · ${photos.length} photo${photos.length > 1 ? 's' : ''}` : ''}`, t.id)
  return { id: c.id }
}

function mine(db: DB, token: string, id: string) {
  const t = ticketFor(db, token)
  const c = (db.complaints ?? []).find(x => x.id === id && x.ticketId === t.id)
  if (!c) throw new Refused('Complaint not found.')
  return c
}

/** The customer writes back on their complaint. A resolved complaint opens again. */
export const customerMessage = (db: DB, token: string, id: string, text: string) => {
  const c = mine(db, token, id)
  const msg = clean(text, 1000)
  if (!msg) throw new Refused('Write a message.')
  if (c.status === 'closed') throw new Refused('This complaint is closed. Please raise a new one if you still need help.')
  if (c.messages.length >= MAX_MESSAGES) throw new Refused('This conversation is full. Please call the parking office.')
  c.messages.push({ at: Date.now(), from: 'customer', text: msg })
  if (c.status === 'resolved') { c.status = 'open'; delete c.resolvedAt }
  log(db, customer, 'complaint', `Customer wrote on complaint ${c.id}`, c.ticketId)
}

function owned(db: DB, s: Staff, id: string) {
  if (s.role !== 'owner') throw new Refused('Only the Owner can handle complaints.')
  const c = (db.complaints ?? []).find(x => x.id === id)
  if (!c) throw new Refused('Complaint not found.')
  return c
}

/** Owner reply: the customer sees it on their ticket page. */
export const replyComplaint = (db: DB, s: Staff, id: string, text: string, resolve?: boolean | null) => {
  const c = owned(db, s, id)
  const msg = clean(text, 1000)
  if (!msg) throw new Refused('Write a reply.')
  if (c.status === 'closed') throw new Refused('This complaint is closed.')
  if (c.messages.length >= MAX_MESSAGES) throw new Refused('This conversation is full. Call the customer instead.')
  const now = Date.now()
  c.messages.push({ at: now, from: 'owner', text: msg })
  c.firstReplyAt ??= now
  c.status = resolve ? 'resolved' : 'open'
  if (resolve) c.resolvedAt = now
  log(db, s, 'complaint', `Replied to complaint ${c.id}${resolve ? ' · marked resolved' : ''}`, c.ticketId)
}

/** Owner-only note (what was checked, who was called…). Never shown to the customer. */
export const noteComplaint = (db: DB, s: Staff, id: string, text: string) => {
  const c = owned(db, s, id)
  const note = clean(text, 1000)
  if (!note) throw new Refused('Write a note.')
  c.notes.push({ at: Date.now(), by: s.name, text: note })
  log(db, s, 'complaint', `Internal note on complaint ${c.id}`, c.ticketId)
}

export const setComplaintStatus = (db: DB, s: Staff, id: string, status: string) => {
  const c = owned(db, s, id)
  if (!['open', 'resolved', 'closed'].includes(status)) throw new Refused('Choose a status.')
  if (c.status === status) return
  const now = Date.now()
  c.status = status as ComplaintStatus
  if (status === 'resolved') c.resolvedAt = now
  if (status === 'closed') { c.closedAt = now; c.resolvedAt ??= now }
  if (status === 'open') { delete c.resolvedAt; delete c.closedAt }
  log(db, s, 'complaint', `Complaint ${c.id} → ${STATUS_LABEL[c.status]}`, c.ticketId)
}

/** What the customer page may see: their own complaints on this ticket, without internal notes. */
export function customerComplaints(db: DB, t: Ticket) {
  return (db.complaints ?? []).filter(c => c.ticketId === t.id)
    .map(({ notes: _notes, mobile, photos, ...c }) => ({ ...c, mobile: '••••••' + String(mobile).slice(-4), photos: Array.isArray(photos) ? photos.length : Number(photos) || 0 }))
}
export type CustomerComplaint = ReturnType<typeof customerComplaints>[number]

/** Daily tidy-up: close resolved complaints after 7 quiet days; delete closed ones after 180 days.
 *  Returns the photo paths to delete from storage. */
export function tidyComplaints(db: DB, now = Date.now()) {
  const gone: string[] = []
  const keep: Complaint[] = []
  let changed = false
  for (const c of db.complaints ?? []) {
    const lastCustomer = Math.max(c.at, ...c.messages.filter(m => m.from === 'customer').map(m => m.at))
    if (c.status === 'resolved' && c.resolvedAt && now - Math.max(c.resolvedAt, lastCustomer) > AUTO_CLOSE_DAYS * DAY) { c.status = 'closed'; c.closedAt = now; changed = true }
    if (c.status === 'closed' && c.closedAt && now - c.closedAt > RETENTION_DAYS * DAY) { gone.push(...c.photos); changed = true; continue }
    keep.push(c)
  }
  if (db.complaints) db.complaints = keep
  // ratings carry no personal data, but keep only a year
  const before = db.ratings?.length ?? 0
  if (db.ratings) db.ratings = db.ratings.filter(r => now - r.at < 365 * DAY)
  if ((db.ratings?.length ?? 0) !== before) changed = true
  return { changed, photos: gone }
}

/** Monthly summary for the Owner: counts by type and status, ratings, and how fast complaints were answered. */
export function complaintSummary(db: DB, month: string /* YYYY-MM, IST */) {
  const inMonth = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).startsWith(month)
  const list = (db.complaints ?? []).filter(c => inMonth(c.at))
  const ratings = (db.ratings ?? []).filter(r => inMonth(r.at))
  const replied = list.filter(c => c.firstReplyAt)
  const resolved = list.filter(c => c.resolvedAt)
  const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined
  return {
    month, total: list.length,
    byType: (Object.keys(COMPLAINT_TYPES) as ComplaintType[]).map(k => ({ type: k, label: COMPLAINT_TYPES[k], n: list.filter(c => c.type === k).length })).filter(x => x.n),
    byStatus: (Object.keys(STATUS_LABEL) as ComplaintStatus[]).map(k => ({ status: k, n: list.filter(c => c.status === k).length })),
    ratings: ratings.length, avgRating: avg(ratings.map(r => r.score)),
    ratingCounts: SMILEYS.map(s => ratings.filter(r => r.score === s.score).length),
    avgReplyHours: avg(replied.map(c => (c.firstReplyAt! - c.at) / 3600_000)),
    avgResolveHours: avg(resolved.map(c => (c.resolvedAt! - c.at) / 3600_000)),
  }
}
