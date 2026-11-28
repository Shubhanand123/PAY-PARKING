// SKC document numbers (owner's choice, format A, 28 Nov 2026).
//   Ticket     SKC-GA1-2611-00142-7   company · site · YYMM (IST) · running number · check digit
//   Receipt    SKC-R-2611-000318
//   Complaint  SKC-C-2611-012
// Running numbers never restart and are never reused; the YYMM part only makes a number easy to place in time.
// The check digit (Luhn over the site, month and number) catches a mistyped digit or two swapped digits.

const IST = 'Asia/Kolkata'

/** YYMM of a moment, in India time. */
export function yymm(at: number) {
  const d = new Date(at).toLocaleDateString('en-CA', { timeZone: IST }) // 2026-11-28
  return d.slice(2, 4) + d.slice(5, 7)
}

/** Luhn check digit over the digits of a string (letters count as their position in 0-9A-Z, so the site counts too). */
export function checkDigit(body: string) {
  const digits = body.toUpperCase().replace(/[^0-9A-Z]/g, '').split('')
    .flatMap(ch => /\d/.test(ch) ? [Number(ch)] : String(ch.charCodeAt(0) - 55).split('').map(Number))
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = digits[digits.length - 1 - i]
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return (10 - (sum % 10)) % 10
}

export const ticketNumber = (site: string, at: number, n: number) => {
  const body = `${site}-${yymm(at)}-${String(n).padStart(5, '0')}`
  return `SKC-${body}-${checkDigit(body)}`
}
export const receiptNumber = (at: number, n: number) => `SKC-R-${yymm(at)}-${String(n).padStart(6, '0')}`
export const complaintNumber = (at: number, n: number) => `SKC-C-${yymm(at)}-${String(n).padStart(3, '0')}`

export const TICKET_RE = /^SKC-([A-Z]{2}\d)-(\d{4})-(\d{5,})-(\d)$/

/** What a typed or scanned ticket number means. */
export type TicketQuery =
  | { kind: 'full'; id: string }                    // complete and the check digit is right
  | { kind: 'bad-check'; id: string; fixed: string } // complete but the check digit is wrong (a typo)
  | { kind: 'number'; n: number }                   // just the running number, e.g. "142" or "00142"
  | { kind: 'old'; id: string }                     // a T-000123 number from before SKC numbers
  | { kind: 'none' }

export function readTicketQuery(input: string): TicketQuery {
  const v = input.trim().toUpperCase().replace(/\s+/g, '').replace(/[–—_/]/g, '-')
  if (!v) return { kind: 'none' }
  const old = /^T-?(\d+)$/.exec(v)
  if (old) return { kind: 'old', id: 'T-' + old[1].padStart(6, '0') }
  if (/^T-[A-Z0-9]{2,4}-\d{4,6}$/.test(v)) return { kind: 'old', id: v } // offline ticket
  const full = /^(?:SKC-?)?([A-Z]{2}\d)-?(\d{4})-?(\d{5,})-?(\d)$/.exec(v)
  if (full) {
    const body = `${full[1]}-${full[2]}-${full[3]}`
    const id = `SKC-${body}-${full[4]}`, right = checkDigit(body)
    return String(right) === full[4] ? { kind: 'full', id } : { kind: 'bad-check', id, fixed: `SKC-${body}-${right}` }
  }
  if (/^\d{1,7}$/.test(v)) return { kind: 'number', n: Number(v) }
  return { kind: 'none' }
}

/** The running number inside a ticket id (SKC or old T- style), or undefined. */
export function runningNumber(id: string) {
  const m = TICKET_RE.exec(id) ?? /^T-(\d+)$/.exec(id)
  return m ? Number(m[3] ?? m[1]) : undefined
}

/** Ticket ids the server accepts: SKC, old T-000123 and offline T-DEV-0001. */
export const anyTicketId = /^(?:SKC-[A-Z]{2}\d-\d{4}-\d{5,}-\d|T-(?:\d{6,}|[A-Z0-9]{2,4}-\d{4,6}))$/
