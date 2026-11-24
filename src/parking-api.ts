import { auth } from './parking-auth'
import type { DB } from './engine'

export const apiEnabled = Boolean(import.meta.env.VITE_PARKING_API)
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

export type Snapshot = { db: DB; role: 'entry' | 'exit' | 'both' | 'owner'; version: number }
let version = -1
export type PaymentEndpoint = 'create-order' | 'verify-payment' | 'check-payment' | 'switch-to-cash'
type ParkingResponse = { snapshot?: Snapshot }

async function requestParking<T extends ParkingResponse>(body: unknown, setupKey?: string, subroute?: PaymentEndpoint): Promise<T> {
  const session = setupKey !== undefined ? null : (await auth?.auth.getSession())?.data.session
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
    window.dispatchEvent(new CustomEvent('parking-snapshot', { detail: data.snapshot }))
  }
  return data as T
}

export function callParking<T>(action: string, args: unknown[] = [], setupKey?: string) {
  return requestParking<ParkingResponse & { result: T; db?: DB }>({ action, args }, action === 'customer' ? '' : setupKey)
}

export function callParkingPayment<T extends object>(endpoint: PaymentEndpoint, payload: Record<string, unknown>) {
  return requestParking<T & ParkingResponse>(payload, payload.ticket_token ? '' : undefined, endpoint)
}
