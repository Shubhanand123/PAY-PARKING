// Calls for reports, day closing, complaints and history. With the server they go to the Edge Function;
// in local mode (no server) they run the same rules on this browser's copy.
import * as engine from './engine'
import { apiEnabled, callParking } from './parking-api'
import * as care from './complaints'
import { closeCash as closeCashRule, type Count } from './closing'
import { buildReport, issueReport as issueRule, sha256, toCsv, type IssuedReport, type Report, type ReportType, type VerifiedReport, verifyReport as verifyRule } from './reports'

function local<R>(fn: (db: engine.DB) => R): R {
  const db = engine.load()
  const result = fn(db)
  engine.save(db)
  window.dispatchEvent(new Event('parking-change'))
  return result
}
const owner = (db: engine.DB) => db.staff.find(s => s.role === 'owner')!

// ---------- Owner ----------
async function ownerAction<R>(name: string, args: unknown[], rule: (db: engine.DB, s: engine.Staff) => R): Promise<R> {
  if (apiEnabled) return (await callParking<R>(name, args)).result
  return local(db => rule(db, owner(db)))
}
export const closeCash = (expectedPaise: number, count: Count, note: string) =>
  ownerAction('closeCash', [expectedPaise, count, note || null], (db, s) => closeCashRule(db, s, expectedPaise, count, note))
export const replyComplaint = (id: string, text: string, resolve: boolean) =>
  ownerAction('replyComplaint', [id, text, resolve], (db, s) => care.replyComplaint(db, s, id, text, resolve))
export const noteComplaint = (id: string, text: string) =>
  ownerAction('noteComplaint', [id, text], (db, s) => care.noteComplaint(db, s, id, text))
export const setComplaintStatus = (id: string, status: care.ComplaintStatus) =>
  ownerAction('setComplaintStatus', [id, status], (db, s) => care.setComplaintStatus(db, s, id, status))

/** Build a report and register its check code. The server builds it from its own records. */
export async function issueReport(type: ReportType, from: string, to: string): Promise<{ issued: IssuedReport; report: Report }> {
  if (apiEnabled) return (await callParking<{ issued: IssuedReport; report: Report }>('issueReport', [type, from, to])).result
  const db = engine.load()
  const report = buildReport(db, type, from, to)
  const digest = await sha256(toCsv(report))
  const issued = local(d => issueRule(d, owner(d), type, from, to, digest))
  return { issued, report }
}

/** A complaint photo the Owner can open: a 5-minute private link (server) or the picture itself (local mode). */
export async function complaintPhoto(c: care.Complaint, index: number) {
  const p = c.photos[index]
  if (!p) throw new Error('Photo not found.')
  if (p.startsWith('data:')) return p
  return (await callParking<string>('complaintPhoto', [c.id, index])).result
}

/** All visits of a vehicle, or a search over every ticket ever (permanent history when the server has it). */
export async function historyTickets(kind: 'vehicleHistory' | 'searchHistory', q: string, db: engine.DB): Promise<engine.Ticket[]> {
  if (apiEnabled) return (await callParking<engine.Ticket[]>(kind, [q])).result
  const plate = engine.normPlate(q), id = q.toUpperCase()
  return db.tickets.filter(t => kind === 'vehicleHistory' ? t.plate === plate : t.plate.includes(plate) || t.id.includes(id)).sort((a, b) => b.entryAt - a.entryAt)
}

// ---------- Ticket page (customer) ----------
type CustomerReply<R> = { result: R; db: engine.DB }
async function customerAction<R>(name: string, args: unknown[], rule: (db: engine.DB) => R): Promise<CustomerReply<R>> {
  if (apiEnabled) {
    const r = await callParking<R>(name, args, '')
    return { result: r.result, db: r.db! }
  }
  const result = local(rule)
  return { result, db: engine.load() }
}
export const rateVisit = (token: string, score: number, comment?: string) =>
  customerAction('customerRate', [token, score, comment || null], db => care.rateVisit(db, token, score, comment))
export const customerMessage = (token: string, id: string, text: string) =>
  customerAction('customerMessage', [token, id, text], db => care.customerMessage(db, token, id, text))
/** `photos` are JPEG pictures as base64 (no data: prefix), already made small by shrinkPhoto. */
export const addComplaint = (token: string, input: care.ComplaintInput, photos: string[]) =>
  customerAction('customerComplaint', [token, input, photos], db => care.addComplaint(db, token, input, photos.map(p => 'data:image/jpeg;base64,' + p)))

/** Make a phone photo small enough to send (longest side 1280 px, JPEG, under ~300 KB). Returns base64. */
export async function shrinkPhoto(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo.')
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('This photo could not be opened. Try another one.') })
  for (const [side, quality] of [[1280, 0.72], [1024, 0.62], [800, 0.55]] as const) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const b64 = canvas.toDataURL('image/jpeg', quality).split(',')[1]
    if (b64.length <= 400_000) return b64
  }
  throw new Error('This photo is too large. Try another one.')
}

// ---------- Public pages ----------
export type PublicInfo = Pick<engine.Settings, 'operator' | 'siteName' | 'address' | 'phone' | 'gstin' | 'grievanceName' | 'grievancePhone' | 'grievanceEmail'>
export async function publicInfo(): Promise<PublicInfo> {
  if (apiEnabled) return (await callParking<PublicInfo>('publicInfo', [], '')).result
  return engine.load().settings
}
export async function verifyReport(code: string): Promise<VerifiedReport | undefined> {
  if (apiEnabled) {
    try { return (await callParking<VerifiedReport>('verifyReport', [code], '')).result }
    catch (e) { if ((e as { status?: number }).status === 404) return undefined; throw e }
  }
  return verifyRule(engine.load(), code)
}
