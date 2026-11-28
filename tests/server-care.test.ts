import assert from 'node:assert/strict'
import { test } from 'node:test'
import { billFor, createEntry, istDay, runAction, seed, takeCash, type DB } from '../src/engine.ts'

// Server: complaints from the ticket page, Owner-only data kept away from the gates, reports, day closing, history.
test('server: complaints, privacy of owner data, reports, day closing and history fallback', async () => {
  const db = seed(false)
  const ticket = runAction(db, 'ravi', createEntry, 'GA07AB1234', 'car', 0).ticket
  ticket.entryAt -= 3 * 3600_000
  runAction(db, 'sunil', takeCash, ticket.id, ticket.rev, billFor(db, ticket, Date.now()).duePaise)
  let snapshot = { db, version: 1 } as { db: DB; version: number }
  const uploads: string[] = [], deleted: string[] = []
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
    if (url.pathname === '/auth/v1/user') return Response.json({ id: 'owner-1', app_metadata: { parking_role: 'owner', parking_enabled: true, parking_mobile: '+919822012345', parking_label: 'Owner' } })
    if (url.pathname === '/rest/v1/rpc/parking_owner_session_valid') return Response.json(true)
    if (url.pathname.startsWith('/storage/v1/object/complaints/')) { uploads.push(url.pathname); return Response.json({}) }
    if (url.pathname === '/storage/v1/object/complaints' && options?.method === 'DELETE') { deleted.push(...JSON.parse(String(options.body)).prefixes); return Response.json({}) }
    if (url.pathname.startsWith('/storage/v1/object/sign/complaints/')) return Response.json({ signedURL: '/object/sign/complaints/x.jpg?token=abc' })
    if (url.pathname === '/rest/v1/parking_events' || url.pathname === '/rest/v1/parking_tickets') return new Response('relation does not exist', { status: 404 }) // migration not applied yet
    return Response.json([])
  }
  const jwt = 'x.' + btoa(JSON.stringify({ session_id: 's1' })) + '.y'
  const call = async (action: string, args: unknown[], owner = false) => {
    const response = await handler(new Request('https://parking.test/functions/v1/parking', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? { Authorization: 'Bearer ' + jwt } : {}) }, body: JSON.stringify({ action, args }),
    }))
    return { status: response.status, body: await response.json() }
  }
  await import('../supabase/functions/parking/index.ts')

  const jpeg = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3))
  const form = { name: 'Asha Naik', mobile: '9822012345', type: 'damage', message: 'Scratch on the left door', consent: true }
  assert.equal((await call('customerComplaint', [ticket.token, { ...form, consent: false }, [jpeg]])).status, 409, 'refused before storing photos')
  assert.equal(uploads.length, 0)
  assert.equal((await call('customerComplaint', [ticket.token, form, ['bm90IGEganBlZw==']])).status, 400, 'not a JPEG')
  const made = await call('customerComplaint', [ticket.token, form, [jpeg, jpeg]])
  assert.equal(made.status, 200)
  assert.match(made.body.result.id, /^SKC-C-/)
  assert.equal(uploads.length, 2)
  assert.equal(snapshot.db.complaints![0].photos.length, 2)
  const page = made.body.db as DB
  assert.equal(page.complaints!.length, 1)
  assert.equal((page.complaints![0] as unknown as { mobile: string }).mobile, '••••••2345')
  assert.equal(page.complaints![0].notes, undefined)
  assert.equal(page.offlineIssues, undefined)
  assert.equal((await call('customerRate', [ticket.token, 5, null])).status, 200)
  assert.equal((await call('customerMessage', [ticket.token, made.body.result.id, 'Any update?'])).status, 200)

  // The gates (open access) never receive complaints, ratings, reports or cash closes, and cannot act on them.
  const gate = await call('snapshot', [])
  assert.equal(gate.body.snapshot.db.complaints, undefined)
  assert.equal(gate.body.snapshot.db.ratings, undefined)
  assert.equal((await call('replyComplaint', [made.body.result.id, 'hi', false])).status, 403)
  assert.equal((await call('closeCash', [5000, { notes: {}, coinsPaise: 5000 }, null])).status, 403)
  assert.equal((await call('issueReport', ['payments', istDay(Date.now()), istDay(Date.now())])).status, 403)

  // The Owner does.
  const owner = await call('snapshot', [], true)
  assert.equal(owner.body.snapshot.role, 'owner')
  assert.equal(owner.body.snapshot.db.complaints.length, 1)
  assert.equal((await call('replyComplaint', [made.body.result.id, 'We will check the CCTV.', false], true)).status, 200)
  assert.equal(snapshot.db.complaints![0].status, 'open')
  assert.equal((await call('noteComplaint', [made.body.result.id, 'Called customer'], true)).status, 200)
  const photo = await call('complaintPhoto', [made.body.result.id, 0], true)
  assert.match(photo.body.result, /^https:\/\/parking\.test\/storage\/v1\/object\/sign\//)

  const close = await call('closeCash', [5000, { notes: { '50': 1 }, coinsPaise: 0 }, null], true)
  assert.equal(close.status, 200)
  assert.equal(close.body.result.diffPaise, 0)

  const day = istDay(Date.now())
  const rep = await call('issueReport', ['payments', day, day], true)
  assert.equal(rep.status, 200)
  assert.equal(rep.body.result.report.rows.length, 1)
  const verified = await call('verifyReport', [rep.body.result.issued.code])
  assert.equal(verified.status, 200)
  assert.equal(verified.body.result.rows, 1)
  assert.equal((await call('verifyReport', ['ZZZZ-ZZZZ'])).status, 404)
  assert.equal((await call('publicInfo', [])).body.result.operator, db.settings.operator)

  // History tables not there yet (migration not applied): answers from the live records.
  const hist = await call('ticketHistory', [ticket.id], true)
  assert.equal(hist.status, 200)
  assert.equal(hist.body.source, 'live')
  assert.ok(hist.body.result.length >= 3)
  const veh = await call('vehicleHistory', ['GA07AB1234'], true)
  assert.equal(veh.body.result[0].id, ticket.id)
  assert.equal((await call('searchHistory', ['AB12'], true)).body.result.length, 1)
  assert.equal((await call('ticketHistory', [ticket.id])).status, 403, 'gates cannot read history')

  // Settings with grievance officer are accepted; unknown keys are not.
  const settings = { ...snapshot.db.settings, grievanceName: 'S. K. Chowdhary', grievancePhone: '+91 98220 00000' }
  assert.equal((await call('saveSettings', [settings], true)).status, 200)
  assert.equal((await call('saveSettings', [{ ...settings, hack: 1 }], true)).status, 400)
  assert.equal(deleted.length, 0)
})
