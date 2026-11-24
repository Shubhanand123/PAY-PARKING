import { Capacitor, registerPlugin } from '@capacitor/core'

// Inside the Android app, plates are read by the native ML Kit scanner (fast, offline).
// In a normal browser this file does nothing and the web scanner is used.
export type NativeScan = { plate?: string; alternatives?: string[]; qr?: string; cancelled?: boolean }
type PlateReaderPlugin = {
  scan(options: { qr: boolean; title: string }): Promise<NativeScan>
  version(): Promise<{ versionCode: number; versionName: string }>
  openExternal(options: { url: string }): Promise<void>
  print(options: { name: string }): Promise<void>
}
export const PlateReader = registerPlugin<PlateReaderPlugin>('PlateReader')
export const nativeApp = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('PlateReader')

let pending: Promise<NativeScan> | undefined
// One scan at a time: React may mount the scanner twice in development, and a second tap must not open a second camera.
export function nativeScan(qr: boolean, title: string) {
  pending ??= PlateReader.scan({ qr, title }).finally(() => { pending = undefined })
  return pending
}
