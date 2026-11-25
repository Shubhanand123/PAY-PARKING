import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { billFor, createEntry, runAction, seed, type DB } from '../src/engine.ts'

test('parking Razorpay routes bind orders to quotes and settle captured payments once', async () => {
  const keyId = 'rzp_test_fixture'
  const keySecret = 'local-fixture-secret'
  const env: Record<string, string> = {
    SUPABASE_URL: 'https://parking.test',
    PARKING_DEVICE_CACHE_MS: '0',
    SUPABASE_SERVICE_ROLE_KEY: 'local-service',
    RAZORPAY_KEY_ID: keyId,
    RAZORPAY_KEY_SECRET: keySecret,
  }
  const gateKey = 'a'.repeat(64)
  let deviceRole = 'exit'
  let handler: (request: Request) => Promise<Response>
  const db = seed(false)
  const ticket = runAction(db, 'ravi', createEntry, 'GA01VA1234', 'car', 0).ticket
  ticket.entryAt -= 25 * 60_000
  const cashTicket = runAction(db, 'ravi', createEntry, 'GA01VA1235', 'car', 0).ticket
  cashTicket.entryAt = ticket.entryAt
  const linkTicket = runAction(db, 'ravi', createEntry, 'GA01VA1236', 'car', 0).ticket
  linkTicket.entryAt = ticket.entryAt
  const amount = billFor(db, ticket, Date.now()).duePaise
  let snapshot = { db, version: 1 } as { db: DB; version: number }
  let providerCreateCount = 0
  let providerPaymentFetches = 0
  let ordersUnavailable = false
  const provider = {
    id: 'pay_Example', order_id: 'order_Example', status: 'authorized', amount,
    currency: 'INR', amount_refunded: 0,
  }
  const links = new Map<string, Record<string, unknown>>()
  const runtime = globalThis as typeof globalThis & { Deno?: unknown }
  const before = runtime.Deno
  const originalFetch = globalThis.fetch
  runtime.Deno = { env: { get: (key: string) => env[key] }, serve: (callback: typeof handler) => { handler = callback } }

  globalThis.fetch = async (resource, options) => {
    const url = new URL(String(resource))
    const payload = options?.body ? JSON.parse(String(options.body)) : undefined
    if (url.hostname === 'api.razorpay.com') {
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64'))
      if (url.pathname === '/v1/orders') {
        providerCreateCount++
        if (ordersUnavailable) return Response.json({}, { status: 502 })
        assert.equal(payload.amount, amount)
        assert.equal(payload.currency, 'INR')
        return Response.json({ ...payload, id: provider.order_id })
      }
      if (url.pathname === '/v1/payment_links') {
        assert.equal(payload.upi_link, false)
        assert.equal(payload.amount, amount)
        const id = 'plink_Test' + (links.size + 1)
        const link = { ...payload, id, status: 'created', short_url: 'https://rzp.io/i/' + id, amount_paid: 0, payments: null }
        links.set(id, link)
        return Response.json(link)
      }
      const link = links.get(url.pathname.split('/')[3] ?? '')
      if (link) {
        if (url.pathname.endsWith('/cancel')) {
          if (link.status !== 'created') return Response.json({}, { status: 400 })
          link.status = 'cancelled'
        }
        return Response.json(link)
      }
      if (url.pathname === '/v1/payments/' + provider.id) {
        providerPaymentFetches++
        return Response.json(provider)
      }
      if (url.pathname === '/v1/orders/order_Example/payments') return Response.json({ items: [provider] })
    }
    if (url.pathname === '/rest/v1/parking_devices') {
      return Response.json([{ role: deviceRole }])
    }
    if (url.pathname === '/rest/v1/parking_runtime') {
      if (options?.method === 'PATCH') {
        if (url.searchParams.get('version') !== 'eq.' + snapshot.version) return Response.json([])
        snapshot = payload
      }
      return Response.json([snapshot])
    }
    throw new Error('Unexpected fixture request: ' + url.pathname)
  }

  function invoke(path: string, payload: object, authenticated = true) {
    return handler(new Request('https://parking.test/functions/v1/parking' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'X-Device-Key': gateKey } : {}) },
      body: JSON.stringify(payload),
    }))
  }

  try {
    await import('../supabase/functions/parking/index.ts')
    assert.equal((await invoke('', { action: 'posSnapshot', args: [] }, false)).status, 401)
    const pos = await invoke('', { action: 'posSnapshot', args: [] })
    assert.equal(pos.status, 200)
    assert.equal((await pos.json()).snapshot.db.razorpayEnabled, true)
    deviceRole = 'owner'
    assert.equal((await invoke('', { action: 'posSnapshot', args: [] })).status, 403)
    deviceRole = 'exit'
    const request = { ticket_id: ticket.id, amount, currency: 'INR', receipt: ticket.id }
    assert.equal((await invoke('/create-order', request, false)).status, 401)
    assert.equal((await invoke('/create-order', { ...request, amount: 99 })).status, 400)
    assert.equal((await invoke('/create-order', { ...request, amount: amount + 1 })).status, 409)
    assert.equal((await invoke('/create-order', { ...request, ticket_token: ticket.token }, false)).status, 409)
    assert.equal(providerCreateCount, 0)

    ordersUnavailable = true
    assert.equal((await invoke('/create-order', request)).status, 500)
    assert.equal(snapshot.db.tickets[0].onlineCheckout, undefined)
    ordersUnavailable = false
    const response = await invoke('/create-order', request)
    assert.equal(response.status, 200)
    const checkout = await response.json()
    assert.equal(checkout.order_id, provider.order_id)
    assert.equal(checkout.key_id, keyId)
    assert.equal(JSON.stringify(checkout).includes(keySecret), false)
    const retry = await invoke('/create-order', { ...request, ticket_token: ticket.token }, false)
    assert.equal((await retry.json()).order_id, provider.order_id)
    assert.equal(providerCreateCount, 2)
    assert.equal((await invoke('', { action: 'takeCash', args: [ticket.id, snapshot.db.tickets[0].rev, amount] })).status, 409)

    const validSignature = createHmac('sha256', keySecret).update(provider.order_id + '|' + provider.id).digest('hex')
    const verification = { ticket_id: ticket.id, razorpay_order_id: provider.order_id, razorpay_payment_id: provider.id, razorpay_signature: validSignature }
    assert.equal((await invoke('/verify-payment', { ticket_id: ticket.id })).status, 400)
    assert.equal((await invoke('/verify-payment', { ...verification, razorpay_order_id: 'order_Other' })).status, 400)
    assert.equal((await invoke('/verify-payment', { ...verification, razorpay_signature: '0'.repeat(64) })).status, 400)
    assert.equal(providerPaymentFetches, 0)
    assert.equal((await invoke('/verify-payment', verification)).status, 409)
    assert.equal(snapshot.db.tickets[0].status, 'inside')
    provider.status = 'captured'
    provider.amount++
    assert.equal((await invoke('/verify-payment', verification)).status, 400)
    provider.amount--
    assert.equal((await invoke('/verify-payment', verification)).status, 200)
    assert.equal((await invoke('/check-payment', { ticket_token: ticket.token }, false)).status, 200)
    assert.equal((await invoke('/verify-payment', verification)).status, 200)
    assert.equal(snapshot.db.tickets[0].status, 'paid')
    assert.deepEqual(snapshot.db.payments.map(({ amountPaise, method }) => ({ amountPaise, method })), [{ amountPaise: amount, method: 'razorpay' }])

    const qrRequest = (id: string) => ({ ticket_id: id, amount, currency: 'INR', receipt: id, pos_qr: true })
    const cashOrder = await (await invoke('/create-order', qrRequest(cashTicket.id))).json()
    assert.match(cashOrder.link_url, /^https:\/\/rzp\.io\//)
    assert.equal((await invoke('/switch-to-cash', { ticket_token: cashTicket.token }, false)).status, 403)
    assert.equal((await invoke('', { action: 'takeCash', args: [cashTicket.id, snapshot.db.tickets[1].rev, amount] })).status, 409)
    const changed = await invoke('/switch-to-cash', { ticket_id: cashTicket.id })
    assert.equal(changed.status, 200)
    assert.equal(links.get(cashOrder.order_id)?.status, 'cancelled')
    assert.equal(snapshot.db.tickets[1].onlineCheckout, undefined)
    assert.equal((await invoke('', { action: 'takeCash', args: [cashTicket.id, (await changed.json()).revision, amount] })).status, 200)
    assert.equal(snapshot.db.payments.at(-1)?.method, 'cash')

    const paidOrder = await (await invoke('/create-order', qrRequest(linkTicket.id))).json()
    provider.id = 'pay_Link'
    provider.order_id = 'order_Link'
    Object.assign(links.get(paidOrder.order_id)!, { status: 'paid', amount_paid: amount, order_id: provider.order_id, payments: [{ payment_id: provider.id, status: 'captured' }] })
    assert.equal((await invoke('/switch-to-cash', { ticket_id: linkTicket.id })).status, 409)
    assert.equal((await invoke('/check-payment', { ticket_id: linkTicket.id })).status, 200)
    assert.equal(snapshot.db.tickets[2].status, 'paid')
    assert.equal(snapshot.db.payments.at(-1)?.method, 'razorpay')
  } finally {
    globalThis.fetch = originalFetch
    runtime.Deno = before
  }
})
