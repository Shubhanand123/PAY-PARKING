import { getSession } from './parking-auth'
import type { DB } from './engine'
import { withPending, type OfflineOp } from './offline-sync'

export const apiEnabled = Boolean(import.meta.env.VITE_PARKING_API)
/** Temporary: no sign-in. The server must also have PARKING_OPEN_ACCESS=true. */
export const openAccess = import.meta.env.VITE_OPEN_ACCESS === 'true'
const keyName = 'parking-device-key'
export const deviceKey = () => localStorage.getItem(keyName) ?? ''
export function setDeviceKey(key: string) {
  if (key) localStorage.setItem(keyName, key)
  else localStorage.removeItem(keyName)
}

export class ParkingApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export type Snapshot = { db: DB; role: 'entry' | 'exit' | 'both' | 'owner' | 'open'; version: number }
let version = -1

// ---------- offline: saved copy of the records + work waiting to be sent ----------
const SNAP_KEY = 'parkar-snapshot', OUTBOX_KEY = 'parkar-outbox', DEVICE_KEY = 'parkar-device', COUNT_KEY = 'parkar-offline-count'
const read = <T>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback } catch { return fallback } }
let serverSnapshot: Snapshot | undefined = read<Snapshot | undefined>(SNAP_KEY, undefined)
export const outbox = (): OfflineOp[] => read<OfflineOp[]>(OUTBOX_KEY, [])
function saveOutbox(ops: OfflineOp[]) { localStorage.setItem(OUTBOX_KEY, JSON.stringify(ops)); window.dispatchEvent(new CustomEvent('parkar-outbox', { detail: ops.length })) }
/** What the POS shows: the last server records plus offline work not yet sent. */
export function currentSnapshot(): Snapshot | undefined {
  return serverSnapshot && { ...serverSnapshot, db: withPending(serverSnapshot.db, outbox()) }
}
function showSnapshot() { const s = currentSnapshot(); if (s) window.dispatchEvent(new CustomEvent('parking-snapshot', { detail: s })) }
/** This POS's short code for offline ticket numbers, e.g. K7. */
export function deviceCode() {
  let code = localStorage.getItem(DEVICE_KEY)
  if (!code) {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ', digits = '23456789'
    const r = crypto.getRandomValues(new Uint8Array(2))
    code = letters[r[0] % letters.length] + digits[r[1] % digits.length]
    localStorage.setItem(DEVICE_KEY, code)
  }
  return code
}
export function nextOfflineTicketId() {
  const n = Number(localStorage.getItem(COUNT_KEY) ?? '0') + 1
  localStorage.setItem(COUNT_KEY, String(n))
  return `T-${deviceCode()}-${String(n).padStart(4, '0')}`
}
export function queueOffline(op: OfflineOp) { saveOutbox([...outbox(), op]); showSnapshot() }
/** A failure that means "no internet" (as opposed to the server refusing). */
export const isOfflineError = (error: unknown) => !navigator.onLine || error instanceof TypeError || (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError'))
let syncing = false
/** Send saved offline work. Safe to call often; the server ignores anything it already has. */
export async function syncOutbox() {
  const ops = outbox()
  if (!ops.length || syncing || !navigator.onLine) return
  syncing = true
  try {
    const r = await callParking<{ done: string[]; issues: number }>('syncOffline', [ops.map(op => ({ ...op, device: deviceCode() }))])
    const done = new Set(r.result.done)
    saveOutbox(outbox().filter(op => !done.has(op.opId)))
    showSnapshot()
  } catch { /* try again on the next round */ } finally { syncing = false }
}
export type PaymentEndpoint = 'create-order' | 'verify-payment' | 'check-payment' | 'switch-to-cash'
type ParkingResponse = { snapshot?: Snapshot }

async function requestParking<T extends ParkingResponse>(body: unknown, setupKey?: string, subroute?: PaymentEndpoint): Promise<T> {
  // Owner signed in: send the Owner's session. Otherwise an approved POS sends its device key; open gates send nothing.
  const session = setupKey !== undefined ? null : await getSession()
  const key = setupKey ?? (session ? '' : deviceKey())
  const endpoint = import.meta.env.VITE_PARKING_API.replace(/\/$/, '')
  const response = await fetch(endpoint + (subroute ? '/' + subroute : ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: 'Bearer ' + session.access_token } : {}), ...(key ? { 'X-Device-Key': key } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  })
  const data = await response.json().catch(() => { throw new ParkingApiError('Parking server unavailable. Please retry.', response.status) })
  if (!response.ok) throw new ParkingApiError(data.error ?? 'Parking server unavailable.', response.status)
  if (data.snapshot && data.snapshot.version >= version) {
    version = data.snapshot.version
    serverSnapshot = data.snapshot
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(data.snapshot)) } catch { /* storage full: still works online */ }
    showSnapshot()
  }
  return data as T
}

export function callParking<T>(action: string, args: unknown[] = [], setupKey?: string) {
  return requestParking<ParkingResponse & { result: T; db?: DB }>({ action, args }, action === 'customer' ? '' : setupKey)
}

// One QR request per ticket at a time: the bill screen starts making the QR early, and the pay screen
// joins that same request instead of asking Razorpay for a second QR.
const qrInFlight = new Map<string, Promise<unknown>>()
export function callParkingPayment<T extends object>(endpoint: PaymentEndpoint, payload: Record<string, unknown>) {
  const send = () => requestParking<T & ParkingResponse>(payload, payload.ticket_token ? '' : undefined, endpoint)
  if (endpoint !== 'create-order') return send()
  const key = [payload.ticket_id, payload.ticket_token, payload.amount, payload.upi_qr].join('|')
  const running = qrInFlight.get(key) as Promise<T & ParkingResponse> | undefined
  if (running) return running
  const request = send().finally(() => qrInFlight.delete(key))
  qrInFlight.set(key, request)
  return request
}
