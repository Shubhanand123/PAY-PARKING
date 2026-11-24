import * as engine from './engine'
import { apiEnabled, callParking, currentSnapshot, isOfflineError, nextOfflineTicketId, queueOffline } from './parking-api'
import { applyOp, type OfflineOp } from './offline-sync'

function action<A extends unknown[], R>(name: string, fn: (db: engine.DB, staff: engine.Staff, ...args: A) => R, offline?: (staffId: string, ...args: A) => R) {
  return async (staffId: string, ...args: A): Promise<R> => {
    if (apiEnabled) {
      try { return (await callParking<R>(name, args)).result }
      catch (error) { if (offline && isOfflineError(error)) return offline(staffId, ...args); throw error }
    }
    const db = engine.load()
    const result = engine.runAction(db, staffId, fn, ...args)
    engine.save(db)
    window.dispatchEvent(new Event('parking-change'))
    return result
  }
}

// ---------- offline: do the work on this POS now, send it when the internet is back ----------
const opId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')
const gate = (staffId: string): OfflineOp['staffId'] => staffId === 'sunil' ? 'sunil' : 'ravi'

/** Check the op works on the POS's copy of the records (same rules as the server), then save it to send later. */
function runOffline(op: OfflineOp) {
  const snap = currentSnapshot()
  if (!snap) throw new Error('No internet, and this POS has no saved records yet. Connect once to start working offline.')
  const db: engine.DB = JSON.parse(JSON.stringify(snap.db))
  const problem = applyOp(db, op)
  if (problem) throw new Error(problem)
  queueOffline(op)
  return db
}
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')

function offlineEntry(staffId: string, plate: string, category: string, prepaidHours: number, _note?: string, _expected?: number | null): { ticket: engine.Ticket; duplicate: boolean } {
  if (prepaidHours > 0) throw new Error('No internet: pay-before-parking needs a connection. Choose Pay at exit.')
  const snap = currentSnapshot()
  const inside = snap && engine.findActiveByPlate(snap.db, plate)
  if (inside) return { ticket: inside, duplicate: true }
  const id = nextOfflineTicketId()
  const db = runOffline({ opId: opId(), kind: 'entry', at: Date.now(), staffId: gate(staffId), ticketId: id, token: token(), plate: engine.normPlate(plate), category })
  return { ticket: db.tickets.find(t => t.id === id)!, duplicate: false }
}
function offlineTicket(kind: 'cash' | 'exit' | 'print') {
  return (staffId: string, id: string, a?: unknown, b?: unknown) => {
    const op: OfflineOp = { opId: opId(), kind, at: Date.now(), staffId: gate(staffId), ticketId: id }
    if (kind === 'cash') op.paise = b as number
    if (kind === 'print') { op.what = (a as 'slip' | 'receipt' | null) ?? 'slip'; op.staffId = op.what === 'receipt' ? 'sunil' : 'ravi' }
    const db = runOffline(op)
    const t = db.tickets.find(x => x.id === id)!
    return t
  }
}

export const createEntry = action('createEntry', engine.createEntry, offlineEntry)
export const markPrinted = action('markPrinted', engine.markPrinted, offlineTicket('print') as never)
export const logLookup = action('logLookup', engine.logLookup, () => undefined as never)
export const takeCash = action('takeCash', engine.takeCash, offlineTicket('cash') as never)
export const recordExit = action('recordExit', engine.recordExit, offlineTicket('exit') as never)
export const cancelTicket = action('cancelTicket', engine.cancelTicket)
export const publishTariff = action('publishTariff', engine.publishTariff)
export const saveSettings = action('saveSettings', engine.saveSettings)
export const addFreeVehicle = action('addFreeVehicle', engine.addFreeVehicle)
export const removeFreeVehicle = action('removeFreeVehicle', engine.removeFreeVehicle)
