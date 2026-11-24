import assert from 'node:assert/strict'
import { test } from 'node:test'
import { billFor, createEntry, runAction, seed, type DB } from '../src/engine.ts'

// The server accepts the new receipt actions, still understands older devices, and keeps Owner actions behind sign-in.
test('server: receipt prints, older print calls, and Owner-only actions', async () => {
  const db = seed(false)
  const ticket = runAction(db, 'ravi', createEntry, 'GA07AB1234', 'car', 0).ticket
  ticket.entryAt -= 3 * 3600_000
  let snapshot = { db, version: 1 } as { db: DB; version: number }
  let handler!: (request: Request) => Promise<Response>
  const env: Record<string, string> = { SUPABASE_URL: 'https://parking.test', SUPABASE_SERVICE_ROLE_KEY: 'local-service', PARKING_OPEN_ACCESS: 'true' }
  const runtime = globalThis as typeof globalThis & { Deno?: unknown }
  runtime.Deno = { env: { get: (key: string) => env[key] }, serve: (callback: typeof handler) => { handler = callback } }
  globalThis.fetch = async (resource, options) => {
    const url = new URL(String(resource))
    if (url.pathname === '/rest/v1/parking_runtime') {
      if (options?.method === 'PATCH') {
        if (url.searchParams.get('version') !== 'eq.' + snapshot.version) return Response.json([])
        snapshot = { ...JSON.parse(String(options.body)), version: snapshot.version + 1 }
      }
      return Response.json([snapshot])
    }
    return Response.json([])
  }
  const call = async (action: string, args: unknown[]) => {
    const response = await handler(new Request('https://parking.test/functions/v1/parking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, args }) }))
    return { status: response.status, body: await response.json() }
  }
  const find = () => snapshot.db.tickets.find(t => t.id === ticket.id)!
  await import('../supabase/functions/parking/index.ts')

  assert.equal((await call('markPrinted', [ticket.id])).status, 200, 'older devices: no slip/receipt argument')
  assert.equal(find().prints, 1)
  assert.equal((await call('markPrinted', [ticket.id, 'poster'])).status, 400, 'unknown print kind refused')
  assert.equal((await call('markPrinted', [ticket.id, 'receipt'])).status, 409, 'no receipt before payment')

  const due = billFor(snapshot.db, find(), Date.now()).duePaise
  assert.equal((await call('takeCash', [ticket.id, find().rev, due])).status, 200)
  assert.ok(find().receipt, 'receipt copy saved on the server')
  assert.equal((await call('markPrinted', [ticket.id, 'receipt'])).status, 200)
  assert.equal(find().receiptPrints, 1)
  assert.equal(find().prints, 1, 'receipt print does not count as a slip reprint')

  // Open access is for the gates only: Owner actions need the signed-in Owner.
  for (const [action, args] of [['addFreeVehicle', ['GA 01 Z 9087', 'Police']], ['removeFreeVehicle', ['GA01Z9087']], ['saveSettings', [snapshot.db.settings]], ['publishTariff', [5, {}, 'x']]] as const) {
    assert.equal((await call(action, [...args])).status, 403, action + ' refused without the Owner sign-in')
  }
  assert.equal(snapshot.db.freeVehicles, undefined, 'nothing changed')
})
