import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed, billFor } from '../src/engine.ts'
import { applyOp, withPending, type OfflineOp } from '../src/offline-sync.ts'

const H = 3600_000
test('offline entry and cash exit are recorded at the time they happened, with the printed number', () => {
  const db = seed(false)
  const t0 = Date.now() - 5 * H
  const ops: OfflineOp[] = [
    { opId: 'op-entry-1', kind: 'entry', at: t0, staffId: 'ravi', ticketId: 'T-K7-0001', token: 'a'.repeat(32), plate: 'GA07AB1234', category: 'car' },
  ]
  const view = withPending(db, ops)
  const t = view.tickets.find(x => x.id === 'T-K7-0001')!
  assert.equal(t.entryAt, t0)
  assert.equal(t.token, 'a'.repeat(32))
  const due = billFor(view, t, t0 + 3 * H).duePaise
  ops.push({ opId: 'op-cash-1', kind: 'cash', at: t0 + 3 * H, staffId: 'sunil', ticketId: 'T-K7-0001', paise: due })
  ops.push({ opId: 'op-exit-1', kind: 'exit', at: t0 + 3 * H + 60_000, staffId: 'sunil', ticketId: 'T-K7-0001' })
  const server = seed(false), map = {}
  for (const op of ops) assert.equal(applyOp(server, op, map), null)
  const s = server.tickets.find(x => x.id === 'T-K7-0001')!
  assert.equal(s.status, 'exited')
  assert.equal(s.billedAt, t0 + 3 * H)
  assert.equal(s.totalPaise, due)
  assert.equal(server.payments.find(p => p.ticketId === 'T-K7-0001')?.amountPaise, due)
})

test('a vehicle already inside elsewhere is flagged, and its offline cash goes to the real ticket', () => {
  const server = seed(false), map: Record<string, string> = {}
  const t0 = Date.now() - 4 * H
  assert.equal(applyOp(server, { opId: 'e-a', kind: 'entry', at: t0, staffId: 'ravi', ticketId: 'T-A2-0001', token: 'b'.repeat(32), plate: 'GA01Z9087', category: 'bike' }, map), null)
  const issue = applyOp(server, { opId: 'e-b', kind: 'entry', at: t0 + H, staffId: 'ravi', ticketId: 'T-B3-0001', token: 'c'.repeat(32), plate: 'GA01Z9087', category: 'bike' }, map)
  assert.match(issue ?? '', /already inside as T-A2-0001/)
  assert.equal(map['T-B3-0001'], 'T-A2-0001')
})
