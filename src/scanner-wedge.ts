// Built-in barcode scanners on Android POS machines usually "type" what they read, very fast, then press
// Enter (sometimes Tab). People type far slower, so a fast burst ending in Enter is treated as one scan.

export type WedgeOptions = { maxGapMs?: number; minLength?: number }

export function createWedgeReader(onScan: (value: string) => void, { maxGapMs = 60, minLength = 6 }: WedgeOptions = {}) {
  let buffer = ''
  let last = -Infinity
  // Returns true when the key ended a scan, so the caller can stop the Enter from doing anything else.
  return (key: string, time: number) => {
    if (key === 'Enter' || key === 'Tab') {
      const value = buffer
      const quick = time - last <= maxGapMs * 2
      buffer = ''
      last = -Infinity
      if (quick && value.length >= minLength) { onScan(value); return true }
      return false
    }
    if (key.length !== 1) return false // Shift, Unidentified and similar arrive inside bursts; skip them.
    buffer = time - last <= maxGapMs ? buffer + key : key
    last = time
    return false
  }
}
