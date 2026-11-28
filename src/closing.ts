// Day closing (step 6, 28 Nov 2026): the Owner counts the cash in the drawer and checks it against
// what the records say was collected in cash since the last close.
//  * A close covers every cash payment not counted by an earlier close (like a shift close on a till).
//    Cash that an offline POS sends in late simply lands in the next close, and the close says so.
//  * When the close is saved those payments are stamped with its id ("locked"): they can never be counted again,
//    and the close itself is never changed or deleted. A mistake is put right by a note on the next close.
//  * Online (Razorpay) money is shown for information; it goes to the bank, not the drawer.

import { istDay, log, Refused, rupees, uid, type DB, type Payment, type Staff } from './engine.ts'

/** Notes and coins the Owner counts. Coins are entered as one rupee total. */
export const NOTES = [500, 200, 100, 50, 20, 10] as const
export type Count = { notes: Partial<Record<`${(typeof NOTES)[number]}`, number>>; coinsPaise: number }

export type CashClose = {
  id: string
  no: number                // 1, 2, 3… never reused
  from: number              // previous close (or first cash payment)
  at: number                // when this close was saved
  day: string               // IST day of the close, YYYY-MM-DD
  by: string
  expectedPaise: number     // cash the records say is in the drawer
  countedPaise: number      // cash the Owner counted
  diffPaise: number         // counted − expected (negative = short)
  count: Count
  note?: string             // required when the count does not match
  cashPayments: number
  late: number              // cash payments dated before the previous close (sent late by an offline POS)
  onlinePaise: number       // online payments since the previous close, for information
  byWho: { name: string; paise: number; n: number }[] // cash by gate / operator
  entries: number; exits: number; insideAtClose: number
}

export const countTotal = (c: Count) => NOTES.reduce((sum, n) => sum + (c.notes[`${n}`] ?? 0) * n * 100, 0) + c.coinsPaise

/** What a close made now would contain. */
export function openCash(db: DB, now = Date.now()) {
  const closes = db.cashCloses ?? []
  const last = closes[closes.length - 1]
  const cash = db.payments.filter(p => p.method === 'cash' && !p.closeId && p.at <= now)
  const from = last?.at ?? Math.min(now, ...cash.map(p => p.at))
  const since = (t: number) => t > from && t <= now
  const who = new Map<string, { name: string; paise: number; n: number }>()
  for (const p of cash) {
    const w = who.get(p.by) ?? { name: p.by, paise: 0, n: 0 }
    w.paise += p.amountPaise; w.n++; who.set(p.by, w)
  }
  return {
    last, from, now,
    payments: cash,
    expectedPaise: cash.reduce((s, p) => s + p.amountPaise, 0),
    late: last ? cash.filter(p => p.at <= last.at).length : 0,
    onlinePaise: db.payments.filter(p => p.method === 'razorpay' && since(p.at)).reduce((s, p) => s + p.amountPaise, 0),
    byWho: [...who.values()].sort((a, b) => b.paise - a.paise),
    entries: db.tickets.filter(t => since(t.entryAt)).length,
    exits: db.tickets.filter(t => t.exitAt != null && since(t.exitAt)).length,
    inside: db.tickets.filter(t => t.status === 'inside' || t.status === 'paid').length,
  }
}

function validCount(c: unknown): c is Count {
  if (!c || typeof c !== 'object') return false
  const { notes, coinsPaise } = c as Count
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return false
  if (Object.keys(notes).some(k => !NOTES.map(String).includes(k))) return false
  const ok = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 100000
  return Object.values(notes).every(ok) && ok(coinsPaise) && (coinsPaise as number) <= 10_000_000
}

/** Save the close. `expectedPaise` is what the Owner saw on screen: if more cash came in meanwhile, nothing is saved. */
export const closeCash = (db: DB, s: Staff, expectedPaise: number, count: Count, note?: string | null) => {
  if (s.role !== 'owner') throw new Refused('Only the Owner can close the day.')
  if (!validCount(count)) throw new Refused('Check the notes and coins you counted.')
  const now = Date.now()
  const open = openCash(db, now)
  if (open.expectedPaise !== expectedPaise) throw new Refused(`More cash came in while you counted: expected cash is now ${rupees(open.expectedPaise)}. Check and save again.`)
  const counted = countTotal(count)
  const diff = counted - open.expectedPaise
  const why = (note ?? '').trim().slice(0, 300)
  if (diff !== 0 && !why) throw new Refused(`The count is ${diff < 0 ? 'short' : 'over'} by ${rupees(Math.abs(diff))}. Write a short note to explain it.`)
  if (!open.payments.length && counted === 0 && open.last && now - open.last.at < 60_000) throw new Refused('The day was just closed.')
  const closes = (db.cashCloses ??= [])
  const c: CashClose = {
    id: uid(), no: (closes[closes.length - 1]?.no ?? 0) + 1, from: open.from, at: now, day: istDay(now), by: s.name,
    expectedPaise: open.expectedPaise, countedPaise: counted, diffPaise: diff, count, ...(why ? { note: why } : {}),
    cashPayments: open.payments.length, late: open.late, onlinePaise: open.onlinePaise, byWho: open.byWho,
    entries: open.entries, exits: open.exits, insideAtClose: open.inside,
  }
  for (const p of open.payments) (p as Payment).closeId = c.id
  closes.push(c)
  log(db, s, 'cash_close', `Day closed #${c.no}: cash expected ${rupees(c.expectedPaise)}, counted ${rupees(counted)}${diff ? ` (${diff < 0 ? 'short' : 'over'} ${rupees(Math.abs(diff))}: ${why})` : ' · matches'}`, undefined, counted)
  return c
}
