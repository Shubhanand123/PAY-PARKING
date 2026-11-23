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

export type Snapshot = { db: DB; role: 'entry' | 'exit' | 'owner'; version: number }
let version = -1
export async function callParking<T>(action: string, args: unknown[] = [], setupKey?: string) {
  const session = action === 'customer' || setupKey !== undefined ? null : (await auth?.auth.getSession())?.data.session
  const key = action === 'customer' ? '' : (setupKey ?? (session ? '' : deviceKey()))
  const response = await fetch(import.meta.env.VITE_PARKING_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: 'Bearer ' + session.access_token } : {}), ...(key ? { 'X-Device-Key': key } : {}) },
    body: JSON.stringify({ action, args }),
    signal: AbortSignal.timeout(12000),
  })
  const data = await response.json()
  if (!response.ok) throw new ParkingApiError(data.error ?? 'Parking server unavailable.', response.status)
  if (data.snapshot && data.snapshot.version >= version) {
    version = data.snapshot.version
    window.dispatchEvent(new CustomEvent('parking-snapshot', { detail: data.snapshot }))
  }
  return data as { result: T; snapshot?: Snapshot; db?: DB }
}
