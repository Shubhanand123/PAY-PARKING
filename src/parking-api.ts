import type { DB } from './engine'

export const apiEnabled = Boolean(import.meta.env.VITE_PARKING_API)
const keyName = 'parking-device-key'
export const deviceKey = () => localStorage.getItem(keyName) ?? ''
export function setDeviceKey(key: string) {
  if (key) localStorage.setItem(keyName, key)
  else localStorage.removeItem(keyName)
}

export type Snapshot = { db: DB; role: 'entry' | 'exit' | 'owner'; version: number }
let version = -1
export async function callParking<T>(action: string, args: unknown[] = [], key = deviceKey()) {
  const response = await fetch(import.meta.env.VITE_PARKING_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Device-Key': key } : {}) },
    body: JSON.stringify({ action, args }),
    signal: AbortSignal.timeout(12000),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? 'Parking server unavailable.')
  if (data.snapshot && data.snapshot.version >= version) {
    version = data.snapshot.version
    window.dispatchEvent(new CustomEvent('parking-snapshot', { detail: data.snapshot }))
  }
  return data as { result: T; snapshot?: Snapshot; db?: DB }
}
