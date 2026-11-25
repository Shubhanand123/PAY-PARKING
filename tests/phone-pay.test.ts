import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed, createEntry, settleOnlinePayment, billFor, takeCash, paidOnPhone, paidUntil } from '../src/engine.ts'

test('customer pays on the phone; exit charges only the extra time, once', () => {
  const db = seed(false)
  const ravi = db.staff.find(s => s.id === 'ravi')!, sunil = db.staff.find(s => s.id === 'sunil')!
  const { ticket } = createEntry(db, ravi, 'GA07AB1234', 'car', 0)
  ticket.entryAt -= 90 * 60_000 // parked 1.5 h
  const due = billFor(db, ticket, Date.now()).duePaise
  assert.ok(due > 0)
  ticket.onlineCheckout = { orderId: 'order_Phone1', amount: due, currency: 'INR', receipt: 'r', billedAt: Date.now(), totalPaise: due, byCustomer: true }
  settleOnlinePayment(db, { ...sunil, name: 'Razorpay' }, ticket, 'order_Phone1', 'pay_Phone1')
  // Paid on the phone: still inside, nothing due now, receipt at the exit.
  assert.equal(ticket.status, 'inside')
  assert.equal(ticket.onlineCheckout, undefined)
  assert.equal(paidOnPhone(db, ticket), due)
  assert.equal(billFor(db, ticket, Date.now()).duePaise, 0)
  assert.ok(paidUntil(db, ticket, due)! > Date.now())
  // The same Razorpay payment arriving again (webhook) changes nothing.
  ticket.onlineCheckout = { orderId: 'order_Phone1', amount: due, currency: 'INR', receipt: 'r', billedAt: Date.now(), totalPaise: due, byCustomer: true }
  settleOnlinePayment(db, { ...sunil, name: 'Razorpay' }, ticket, 'order_Phone1', 'pay_Phone1')
  delete ticket.onlineCheckout
  assert.equal(paidOnPhone(db, ticket), due)
  // Stayed 2 more hours: only the extra is due at the exit.
  ticket.entryAt -= 2 * 3600_000
  const extra = billFor(db, ticket, Date.now()).duePaise
  assert.ok(extra > 0)
  takeCash(db, sunil, ticket.id, ticket.rev, extra)
  assert.equal(ticket.status, 'paid')
  assert.equal(ticket.receipt!.payments.length, 2)
  assert.equal(ticket.receipt!.payments.reduce((s, p) => s + p.amountPaise, 0), ticket.totalPaise)
})
