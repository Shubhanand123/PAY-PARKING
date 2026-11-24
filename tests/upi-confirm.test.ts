import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed, createEntry, confirmUpiByOperator, settleOnlinePayment, recordExit, billFor } from '../src/engine.ts'

test('operator confirms UPI at once; Razorpay completes it later without a second payment', () => {
  const db = seed(false)
  const ravi = db.staff.find(s => s.id === 'ravi')!, sunil = db.staff.find(s => s.id === 'sunil')!
  const { ticket } = createEntry(db, ravi, 'GA07AB1234', 'car', 0)
  ticket.entryAt -= 5 * 3600_000
  const due = billFor(db, ticket, Date.now()).duePaise
  ticket.onlineCheckout = { orderId: 'qr_Test1', amount: due, currency: 'INR', receipt: 'r', billedAt: Date.now(), totalPaise: due }
  confirmUpiByOperator(db, sunil, ticket.id, ticket.rev)
  assert.equal(ticket.status, 'paid')
  assert.ok(ticket.upiCheck)
  assert.equal(db.payments.filter(p => p.ticketId === ticket.id).length, 1)
  recordExit(db, sunil, ticket.id)
  settleOnlinePayment(db, { ...sunil, name: 'Razorpay' }, ticket, 'qr_Test1', 'pay_Test1')
  assert.equal(ticket.upiCheck, undefined)
  const pays = db.payments.filter(p => p.ticketId === ticket.id)
  assert.equal(pays.length, 1)
  assert.equal(pays[0].providerPaymentId, 'pay_Test1')
  assert.equal(ticket.status, 'exited')
})
