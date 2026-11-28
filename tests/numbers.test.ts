import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkDigit, readTicketQuery, receiptNumber, runningNumber, ticketNumber, anyTicketId, yymm } from '../src/numbers.ts'
import { createEntry, findTicketBySlip, seed } from '../src/engine.ts'

const NOV28 = Date.UTC(2026, 10, 28, 6, 0)

test('SKC ticket numbers: format, month in India time, check digit', () => {
  const id = ticketNumber('GA1', NOV28, 142)
  assert.match(id, /^SKC-GA1-2611-00142-\d$/)
  assert.equal(id.at(-1), String(checkDigit('GA1-2611-00142')))
  assert.equal(yymm(Date.UTC(2026, 10, 30, 19, 0)), '2612') // 30 Nov 19:00 UTC = 1 Dec 00:30 IST
  assert.equal(receiptNumber(NOV28, 318), 'SKC-R-2611-000318')
  assert.equal(runningNumber(id), 142)
  assert.equal(runningNumber('T-000101'), 101)
  assert.ok(anyTicketId.test(id) && anyTicketId.test('T-000101') && anyTicketId.test('T-AB12-0003'))
})

test('a mistyped digit or swapped digits are caught by the check digit', () => {
  const id = ticketNumber('GA1', NOV28, 142)
  const good = readTicketQuery(id.toLowerCase().replace(/-/g, ' '))
  assert.deepEqual(good, { kind: 'full', id })
  const typo = readTicketQuery(id.replace('00142', '00143'))
  assert.equal(typo.kind, 'bad-check')
  const swapped = readTicketQuery(id.replace('00142', '00124'))
  assert.equal(swapped.kind, 'bad-check')
  assert.deepEqual(readTicketQuery('142'), { kind: 'number', n: 142 })
  assert.deepEqual(readTicketQuery('t-45'), { kind: 'old', id: 'T-000045' })
})

test('new tickets and receipts get SKC numbers; slip lookup by full number, short number or old number', () => {
  const db = seed(false)
  const staff = db.staff.find(s => s.gate.toLowerCase().includes('entry')) ?? db.staff[0]
  const r = createEntry(db, staff, 'GA07AB1234', db.categories[0].id, 0)
  const t = r.ticket
  assert.match(t.id, /^SKC-GA1-\d{4}-\d{5}-\d$/)
  assert.equal(findTicketBySlip(db.tickets, t.id)?.id, t.id)
  assert.equal(findTicketBySlip(db.tickets, String(runningNumber(t.id)))?.id, t.id)
  assert.equal(findTicketBySlip(db.tickets, t.id.slice(0, -1) + ((Number(t.id.at(-1)) + 1) % 10)), undefined)
})
