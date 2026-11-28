import assert from 'node:assert/strict'
import { test } from 'node:test'
import { billFor, createEntry, istDay, recordExit, runAction, saveSettings, seed, takeCash, Refused, type DB } from '../src/engine.ts'
import { closeCash, countTotal, openCash } from '../src/closing.ts'
import { addComplaint, complaintSummary, customerComplaints, customerMessage, noteComplaint, rateVisit, replyComplaint, setComplaintStatus, tidyComplaints } from '../src/complaints.ts'
import { buildReport, gstSplit, issueReport, sha256, toCsv, verifyReport } from '../src/reports.ts'

const HOUR = 3600_000, DAY = 24 * HOUR
function paid(db: DB, plate: string, hours = 3) {
  const t = runAction(db, 'ravi', createEntry, plate, 'car', 0).ticket
  t.entryAt -= hours * HOUR
  runAction(db, 'sunil', takeCash, t.id, t.rev, billFor(db, t, Date.now()).duePaise)
  return t
}

test('day closing: counts cash since the last close, needs a note when short, never counts a payment twice', () => {
  const db = seed(false)
  paid(db, 'GA07AB1234'); paid(db, 'GA07AB1235')
  const open = openCash(db)
  assert.equal(open.payments.length, 2)
  assert.equal(open.expectedPaise, 2 * 5000)
  const exact = { notes: { '50': 2 }, coinsPaise: 0 }
  assert.equal(countTotal(exact), 10000)
  assert.throws(() => runAction(db, 'sunil', closeCash, open.expectedPaise, exact), Refused, 'owner only')
  assert.throws(() => runAction(db, 'owner', closeCash, 9000, exact), /More cash came in/, 'stale expected amount')
  const short = { notes: { '50': 1, '20': 2 }, coinsPaise: 500 }
  assert.throws(() => runAction(db, 'owner', closeCash, open.expectedPaise, short), /short by ₹5/, 'difference needs a note')
  const c = runAction(db, 'owner', closeCash, open.expectedPaise, short, 'Gave change from own pocket')
  assert.equal(c.no, 1)
  assert.equal(c.diffPaise, -500)
  assert.ok(db.payments.every(p => p.closeId === c.id), 'payments are stamped (locked)')
  assert.equal(openCash(db).expectedPaise, 0, 'nothing left to count')
  // cash arriving late from an offline POS, dated before the close, goes into the next close and is flagged
  paid(db, 'GA07AB1236')
  db.payments[db.payments.length - 1].at = c.at - 60_000
  const next = openCash(db)
  assert.equal(next.expectedPaise, 5000)
  assert.equal(next.late, 1)
  const c2 = runAction(db, 'owner', closeCash, 5000, { notes: { '50': 1 }, coinsPaise: 0 })
  assert.equal(c2.no, 2)
  assert.equal(c2.late, 1)
  assert.equal(db.audit.filter(a => a.kind === 'cash_close').length, 2)
})

test('complaints: tied to a real ticket, private details masked on the customer page, owner-only notes', () => {
  const db = seed(false)
  const t = paid(db, 'GA07AB1234')
  const good = { name: 'Asha Naik', mobile: '+91 98220 12345', type: 'overcharge', message: 'Charged for 3 hours, I stayed 2.', consent: true }
  assert.throws(() => addComplaint(db, 'nope', good), /Ticket not found/)
  assert.throws(() => addComplaint(db, t.token, { ...good, consent: false }), /consent/)
  assert.throws(() => addComplaint(db, t.token, { ...good, mobile: '12345' }), /mobile/)
  assert.throws(() => addComplaint(db, t.token, { ...good, type: 'weather' }), /Choose what/)
  assert.throws(() => addComplaint(db, t.token, good, ['a', 'b', 'c', 'd']), /at most 3/)
  const { id } = addComplaint(db, t.token, good, ['2026-11-28/x.jpg'])
  assert.match(id, /^SKC-C-\d{4}-001$/)
  const c = db.complaints![0]
  assert.equal(c.mobile, '9822012345')
  assert.equal(c.status, 'new')
  assert.ok(!db.audit.some(a => a.text.includes('Asha') || a.text.includes('9822')), 'no personal data in the activity log')

  assert.throws(() => runAction(db, 'sunil', replyComplaint, id, 'Sorry'), Refused, 'gates cannot reply')
  runAction(db, 'owner', noteComplaint, id, 'CCTV checked: entry 10:02')
  runAction(db, 'owner', replyComplaint, id, 'Sorry, ₹20 will be refunded at the office.', true)
  assert.equal(c.status, 'resolved')
  assert.ok(c.firstReplyAt)
  const view = customerComplaints(db, t)[0] as Record<string, unknown>
  assert.equal(view.notes, undefined, 'internal notes never reach the customer')
  assert.equal(view.mobile, '••••••2345')
  assert.equal(view.photos, 1)
  customerMessage(db, t.token, id, 'Thanks, collected.')
  assert.equal(c.status, 'open', 'customer reply reopens a resolved complaint')
  runAction(db, 'owner', setComplaintStatus, id, 'closed')
  assert.throws(() => customerMessage(db, t.token, id, 'again'), /closed/)

  rateVisit(db, t.token, 2)
  rateVisit(db, t.token, 4, 'Quick reply')
  assert.equal(db.ratings!.length, 1, 'one rating per ticket')
  assert.equal(db.ratings![0].score, 4)
  const month = istDay(Date.now()).slice(0, 7)
  const sum = complaintSummary(db, month)
  assert.equal(sum.total, 1)
  assert.equal(sum.avgRating, 4)

  // retention: deleted with photos 180 days after closing
  c.closedAt = Date.now() - 181 * DAY
  const gone = tidyComplaints(db)
  assert.deepEqual(gone.photos, ['2026-11-28/x.jpg'])
  assert.equal(db.complaints!.length, 0)
})

test('resolved complaints close by themselves after 7 quiet days', () => {
  const db = seed(false)
  const t = paid(db, 'GA07AB1234')
  const { id } = addComplaint(db, t.token, { name: 'Ravi', mobile: '9876543210', type: 'other', message: 'Lights off at night', consent: true })
  runAction(db, 'owner', setComplaintStatus, id, 'resolved')
  const c = db.complaints![0]
  c.resolvedAt = c.at = Date.now() - 8 * DAY
  tidyComplaints(db)
  assert.equal(c.status, 'closed')
})

test('reports: GST split adds up, CSV is formula-safe, check code verifies', async () => {
  for (const p of [100, 2000, 5000, 11800, 33333]) { const g = gstSplit(p); assert.equal(g.taxable + g.cgst + g.sgst, p) }
  assert.deepEqual(gstSplit(11800), { taxable: 10000, cgst: 900, sgst: 900 })
  const db = seed(false)
  runAction(db, 'owner', saveSettings, { ...db.settings, gstin: '30ABCDE1234F1Z5' })
  runAction(db, 'sunil', recordExit, paid(db, 'GA07AB1234').id); paid(db, 'GA07AB1234', 5)
  const day = istDay(Date.now())
  const pay = buildReport(db, 'payments', day, day)
  assert.equal(pay.rows.length, 2)
  assert.ok(pay.columns.includes('CGST 9% (₹)'))
  assert.equal(pay.totals.find(t => t[0] === 'Total')?.[1], '₹140')
  const veh = buildReport(db, 'vehicles', day, day)
  assert.equal(veh.rows.length, 1)
  assert.equal(veh.rows[0][2], '2')
  assert.throws(() => buildReport(db, 'tickets', day, '2020-01-01'), /valid date range/)
  db.audit.push({ id: 'x', at: Date.now(), by: '=HYPERLINK("x")', kind: 'settings', text: 'a,b' })
  const csv = toCsv(buildReport(db, 'audit', day, day))
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), 'formula cell is defused')
  assert.ok(csv.includes('"a,b"'))
  const digest = await sha256(toCsv(pay))
  const issued = runAction(db, 'owner', issueReport, 'payments', day, day, digest)
  assert.match(issued.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  const v = verifyReport(db, issued.code.toLowerCase().replace('-', ' '))
  assert.equal(v?.rows, 2)
  assert.equal(v?.digest, digest)
  assert.equal(verifyReport(db, 'AAAA-BBBB'), undefined)
  assert.throws(() => runAction(db, 'sunil', issueReport, 'payments', day, day, digest), Refused)
})
