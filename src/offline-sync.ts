// Offline gate work. When the POS has no internet, entries, cash exits and prints are saved on the POS as
// "ops" and sent to the server when it is back. The SAME applyOp runs on the POS (to show the result at once)
// and on the server (to record it), each at the time the op really happened, so both get the same bill.
import { createEntry, markPrinted, normPlate, prettyPlate, recordExit, Refused, rupees, takeCash, type DB } from './engine.ts'

export type OfflineOp = {
  opId: string            // unique, so a retry never applies an op twice
  kind: 'entry' | 'cash' | 'exit' | 'print'
  at: number              // when it happened on the POS (ms)
  staffId: 'ravi' | 'sunil'
  ticketId: string        // offline tickets: T-<device>-<n>, e.g. T-K7-0001
  token?: string          // entry: the token printed in the slip's QR
  plate?: string; category?: string   // entry
  paise?: number          // cash: amount collected
  what?: 'slip' | 'receipt'           // print
  device?: string         // POS code, for the Owner's "Check these" list
}
export type OfflineIssue = { at: number; opId: string; ticketId: string; device?: string; text: string }

export const offlineTicketId = /^T-[A-Z0-9]{2,4}-\d{4,6}$/

/** Run fn as if the clock were `at`. */
function at<T>(time: number, fn: () => T): T {
  const real = Date.now
  Date.now = () => time
  try { return fn() } finally { Date.now = real }
}

/**
 * Apply one offline op. `idMap` maps an offline ticket number to the server's ticket when the vehicle was
 * already inside (entered at another gate). Returns a problem for the Owner to check, or null.
 */
export function applyOp(db: DB, op: OfflineOp, idMap: Record<string, string> = {}): string | null {
  const staff = db.staff.find(s => s.id === op.staffId)
  if (!staff) return 'Unknown gate.'
  const id = idMap[op.ticketId] ?? op.ticketId
  const when = new Date(op.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })
  try {
    if (op.kind === 'entry') {
      if (db.tickets.some(t => t.id === op.ticketId)) return null // already recorded
      const before = db.seq
      const r = at(op.at, () => createEntry(db, staff, op.plate ?? '', op.category ?? '', 0, 'entered offline'))
      if (r.duplicate) {
        idMap[op.ticketId] = r.ticket.id
        return `${prettyPlate(normPlate(op.plate ?? ''))} was entered offline at ${when} (${op.ticketId}) but was already inside as ${r.ticket.id}. The offline slip now points to ${r.ticket.id}.`
      }
      // Keep the number and QR printed on the offline slip.
      const oldId = r.ticket.id
      r.ticket.id = op.ticketId
      if (op.token) r.ticket.token = op.token
      db.seq = before
      for (const a of db.audit) if (a.ticketId === oldId) a.ticketId = op.ticketId
      for (const p of db.payments) if (p.ticketId === oldId) p.ticketId = op.ticketId
      return null
    }
    const t = db.tickets.find(x => x.id === id)
    if (!t) return `${op.kind === 'cash' ? 'Cash' : op.kind === 'exit' ? 'Exit' : 'Print'} for ${op.ticketId} at ${when}: ticket not found.`
    if (op.kind === 'cash') {
      if (t.status === 'paid' || t.status === 'exited') return null // already recorded
      at(op.at, () => takeCash(db, staff, id, t.rev, op.paise ?? 0))
      return null
    }
    if (op.kind === 'exit') {
      if (t.status === 'exited') return null
      at(op.at, () => recordExit(db, staff, id))
      return null
    }
    at(op.at, () => markPrinted(db, staff, id, op.what ?? 'slip'))
    return null
  } catch (error) {
    if (op.kind === 'print') return null
    const why = error instanceof Refused || error instanceof Error ? error.message : String(error)
    return `${op.kind === 'cash' ? `Cash ${rupees(op.paise ?? 0)}` : op.kind === 'exit' ? 'Vehicle left' : 'Entry'} for ${op.ticketId} at ${when} could not be recorded: ${why}`
  }
}

/** The view the POS shows: the server's records plus everything still waiting to be sent. */
export function withPending(db: DB, ops: OfflineOp[]): DB {
  if (!ops.length) return db
  const copy: DB = JSON.parse(JSON.stringify(db))
  const map: Record<string, string> = {}
  for (const op of ops) applyOp(copy, op, map)
  return copy
}
