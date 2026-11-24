import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addFreeVehicle, billFor, createEntry, markPrinted, recordExit, removeFreeVehicle, runAction, saveSettings, seed, takeCash, Refused } from '../src/engine.ts'

const HOUR = 3600_000
function parked(db = seed(false), plate = 'GA07AB1234', hours = 3) {
  const t = runAction(db, 'ravi', createEntry, plate, 'car', 0).ticket
  t.entryAt -= hours * HOUR
  return { db, t }
}

test('paying freezes an exact receipt that later settings changes do not touch', () => {
  const { db, t } = parked()
  const due = billFor(db, t, Date.now()).duePaise
  assert.ok(due > 0)
  runAction(db, 'sunil', takeCash, t.id, t.rev, due)
  assert.equal(t.status, 'paid')
  assert.ok(t.receipt, 'receipt saved at payment')
  assert.equal(t.receipt!.totalPaise, due)
  assert.equal(t.receipt!.payments[0].amountPaise, due)
  const before = JSON.stringify(t.receipt)
  runAction(db, 'owner', saveSettings, { ...db.settings, operator: 'Renamed Co.', phone: '+91 99999 99999' })
  runAction(db, 'sunil', recordExit, t.id)
  assert.equal(JSON.stringify(t.receipt), before, 'receipt copy stays exactly as printed')
  assert.equal(t.receipt!.operator, 'Your Parking Co.')
})

test('slip and receipt prints are counted and audited separately', () => {
  const { db, t } = parked()
  runAction(db, 'ravi', markPrinted, t.id)               // older devices send no kind: slip
  runAction(db, 'ravi', markPrinted, t.id, 'slip')
  assert.throws(() => runAction(db, 'sunil', markPrinted, t.id, 'receipt'), Refused, 'no receipt before payment')
  runAction(db, 'sunil', takeCash, t.id, t.rev, billFor(db, t, Date.now()).duePaise)
  runAction(db, 'sunil', markPrinted, t.id, 'receipt')
  runAction(db, 'owner', markPrinted, t.id, 'receipt')
  assert.equal(t.prints, 2)
  assert.equal(t.receiptPrints, 2)
  const kinds = db.audit.filter(a => a.ticketId === t.id).map(a => a.kind)
  assert.deepEqual(kinds.filter(k => k.includes('print')), ['print', 'reprint', 'receipt_print', 'receipt_reprint'])
})

test('designated free vehicles pay nothing and the waived amount is recorded', () => {
  const db = seed(false)
  assert.throws(() => runAction(db, 'ravi', addFreeVehicle, 'GA01Z9087', 'Staff'), Refused, 'only the owner')
  runAction(db, 'owner', addFreeVehicle, 'ga 01 z 9087', 'Police', 'Patrol jeep')
  const { t } = parked(db, 'GA01Z9087', 5)
  const bill = billFor(db, t, Date.now())
  assert.equal(bill.duePaise, 0)
  assert.equal(bill.totalPaise, 0)
  assert.equal(bill.free?.reason, 'Police')
  assert.ok(bill.free!.waivedPaise > 0)
  runAction(db, 'sunil', takeCash, t.id, t.rev, 0)
  assert.deepEqual(t.free, bill.free)
  assert.deepEqual(t.receipt!.free, bill.free)
  assert.equal(db.payments.filter(p => p.ticketId === t.id).length, 0, 'no money taken')
  // Removing the vehicle from the list later does not change what was already billed.
  runAction(db, 'owner', removeFreeVehicle, 'GA01Z9087')
  assert.equal(billFor(db, t, Date.now()).duePaise, 0)
  assert.equal(billFor(db, t, Date.now()).free?.reason, 'Police')
  // A new visit after removal is charged normally.
  runAction(db, 'sunil', recordExit, t.id)
  const again = parked(db, 'GA01Z9087', 3).t
  assert.ok(billFor(db, again, Date.now()).duePaise > 0)
})
