import {
  capturedQrPayment, closeRazorpayQr, createRazorpayQr, razorpayQrId,
  cancelRazorpayLink, createRazorpayLink, createRazorpayOrder, fetchRazorpayLink, fetchRazorpayPayment, findCapturedPayment, RazorpayServiceError,
  razorpayLinkId, razorpayOrderId, razorpayPaymentId, razorpaySignature, verifyRazorpaySignature,
} from './razorpay.ts'
import { loginAlias, pairedPassword } from '../../../src/parking-identity.ts'
import * as parking from '../../../src/engine.ts'
import { applyOp, offlineTicketId, type OfflineOp } from '../../../src/offline-sync.ts'

const endpoint = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const keyId = Deno.env.get('RAZORPAY_KEY_ID')
const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET')
const razorpay = keyId && keySecret ? { keyId, keySecret } : undefined
// Temporary: while PARKING_OPEN_ACCESS=true, requests without a login or device key get full access (role 'open').
const openAccess = Deno.env.get('PARKING_OPEN_ACCESS') === 'true'
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-device-key, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400', // the browser remembers permission for a day: no extra round trip before each call
  'Cache-Control': 'no-store',
}
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers })

async function database<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(endpoint + '/rest/v1/' + path, {
    ...options,
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json', ...options.headers },
  })
  if (!response.ok) throw new Error('Database request failed.')
  return response.json()
}

type AuthUser = {
  id: string
  phone?: string
  email?: string
  app_metadata?: { parking_role?: 'owner' | 'entry' | 'exit' | 'both'; parking_label?: string; parking_mobile?: string; parking_enabled?: boolean }
}

async function authRequest(path: string, options: RequestInit = {}, bearer = serviceKey) {
  return fetch(endpoint + '/auth/v1/' + path, {
    ...options,
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
  })
}

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const randomToken = (size = 32) => hex(crypto.getRandomValues(new Uint8Array(size)))
const validMobile = (value: unknown): value is string => typeof value === 'string' && /^\+91[6-9]\d{9}$/.test(value)
type GateAccess = 'entry' | 'exit' | 'both'
const isGate = (value: unknown): value is GateAccess => value === 'entry' || value === 'exit' || value === 'both'
type PosSetup = { mobile: string; label: string; gate: GateAccess; expires_at: string }

const validOwnerPassword = (value: unknown): value is string => typeof value === 'string' && value.length >= 10 && new TextEncoder().encode(value).length <= 72

async function hashCode(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

async function authUsers() {
  const response = await authRequest('admin/users?per_page=1000')
  if (!response.ok) throw new Error('Could not read parking accounts.')
  return (await response.json() as { users: AuthUser[] }).users
}

function verifiedSessionId(token: string) {
  const payload = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/')
  try { return JSON.parse(atob(payload)).session_id } catch { return undefined }
}

async function redeemOwnerCode(args: unknown[]) {
  // The third value is a 4–8 digit PIN (approves this device) or, for older pages, a long password.
  const [mobile, rawCode, secret] = args
  const code = typeof rawCode === 'string' ? rawCode.replace(/[\s-]/g, '').toLowerCase() : ''
  const isPin = typeof secret === 'string' && /^\d{4,8}$/.test(secret)
  if (!validMobile(mobile) || !/^[a-f0-9]{32}$/.test(code) || !(isPin || validOwnerPassword(secret))) {
    return reply({ error: 'Enter the Owner mobile number, the full one-time code, and a PIN of 4 to 8 digits.' }, 400)
  }
  const now = new Date().toISOString()
  const codeHash = await hashCode(code)
  const query = new URLSearchParams({ mobile: 'eq.' + mobile, code_hash: 'eq.' + codeHash, expires_at: 'gt.' + now, used_at: 'is.null' })
  const [pending] = await database<Array<{ mobile: string; device_key: string | null }>>('parking_owner_recovery?select=mobile,device_key&' + query)
  if (!pending) return reply({ error: 'This recovery code is invalid, expired, or already used.' }, 400)
  const email = loginAlias(mobile)
  const existing = (await authUsers()).find(user => user.email === email)
  if (existing && existing.app_metadata?.parking_role !== 'owner') return reply({ error: 'This mobile number is assigned to a POS account.' }, 409)

  const deviceKey = pending.device_key ?? randomToken()
  const [claimed] = await database<Array<{ mobile: string }>>('parking_owner_recovery?select=mobile&' + query, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ used_at: now, invalidate_before: now, ...(isPin ? { device_key: deviceKey } : {}) }),
  })
  if (!claimed) return reply({ error: 'This recovery code is invalid, expired, or already used.' }, 400)
  // PIN sign-in: the real password is derived from the Owner's device key plus the PIN, so a short PIN
  // only works on devices that received the key through a one-time code. All approved devices share it.
  const password = isPin ? await pairedPassword(secret, deviceKey) : secret as string
  const response = await authRequest(existing ? 'admin/users/' + existing.id : 'admin/users', {
    method: existing ? 'PUT' : 'POST',
    body: JSON.stringify(existing ? { password } : {
      email, email_confirm: true, password,
      app_metadata: { parking_role: 'owner', parking_label: 'Owner', parking_mobile: mobile, parking_enabled: true },
    }),
  })
  if (!response.ok) return reply({ error: 'Could not set the password. Ask the Owner to issue a new code.' }, 409)
  if (existing) {
    await database('parking_owner_recovery?' + new URLSearchParams({ mobile: 'eq.' + mobile }), {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ invalidate_before: new Date().toISOString() }),
    })
  }
  return reply({ result: isPin ? { deviceKey } : true })
}

async function redeemPosCode(args: unknown[]) {
  const [mobile, rawCode, pin] = args
  const code = typeof rawCode === 'string' ? rawCode.replace(/[\s-]/g, '').toLowerCase() : ''
  if (!validMobile(mobile) || !/^[a-f0-9]{16}$/.test(code) || typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) {
    return reply({ error: 'Enter your mobile number, setup code and a PIN with 4 to 8 digits.' }, 400)
  }
  const now = new Date().toISOString()
  const query = new URLSearchParams({ mobile: 'eq.' + mobile, code_hash: 'eq.' + await hashCode(code), expires_at: 'gt.' + now, used_at: 'is.null' })
  const path = 'parking_pos_setup?select=mobile,label,gate,expires_at&' + query
  const [pending] = await database<PosSetup[]>(path)
  if (!pending) return reply({ error: 'This setup code is invalid, expired or already used.' }, 400)
  const email = loginAlias(mobile)
  const existing = (await authUsers()).find(user => user.email === email)
  if (existing && (!isGate(existing.app_metadata?.parking_role) || existing.app_metadata?.parking_enabled !== true)) {
    return reply({ error: 'This mobile number is unavailable for POS setup.' }, 409)
  }
  const [claimed] = await database<PosSetup[]>(path, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ used_at: now, invalidate_before: now }),
  })
  if (!claimed) return reply({ error: 'This setup code is invalid, expired or already used.' }, 400)
  const pairingKey = randomToken()
  const password = await pairedPassword(pin, pairingKey)
  const app_metadata = { parking_role: claimed.gate, parking_label: claimed.label, parking_mobile: mobile }
  const response = await authRequest(existing ? 'admin/users/' + existing.id : 'admin/users', {
    method: existing ? 'PUT' : 'POST',
    body: JSON.stringify(existing ? { password, app_metadata } : { email, email_confirm: true, password, app_metadata: { ...app_metadata, parking_enabled: true } }),
  })
  if (!response.ok) return reply({ error: 'Could not save the PIN. Ask the Owner for a new setup code.' }, 409)
  if (existing) await database('parking_pos_setup?' + new URLSearchParams({ mobile: 'eq.' + mobile }), {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ invalidate_before: new Date().toISOString() }),
  })
  return reply({ result: { pairingKey } })
}

const actions = {
  createEntry: { roles: ['entry', 'owner'], fn: parking.createEntry, checks: ['text', 'text', 'integer', 'optionalText', 'optionalInteger'] },
  markPrinted: { roles: ['entry', 'exit', 'owner'], fn: parking.markPrinted, checks: ['text', 'printKind'] },
  logLookup: { roles: ['exit', 'owner'], fn: parking.logLookup, checks: ['text', 'lookup'] },
  takeCash: { roles: ['exit', 'owner'], fn: parking.takeCash, checks: ['text', 'integer', 'integer'] },
  confirmUpi: { roles: ['exit', 'owner'], fn: parking.confirmUpiByOperator, checks: ['text', 'integer'] },
  recordExit: { roles: ['exit', 'owner'], fn: parking.recordExit, checks: ['text'] },
  cancelTicket: { roles: ['exit', 'owner'], fn: parking.cancelTicket, checks: ['text', 'text'] },
  publishTariff: { roles: ['owner'], fn: parking.publishTariff, checks: ['integer', 'rates', 'text'] },
  saveSettings: { roles: ['owner'], fn: parking.saveSettings, checks: ['settings'] },
  addFreeVehicle: { roles: ['owner'], fn: parking.addFreeVehicle, checks: ['text', 'text', 'optionalText'] },
  removeFreeVehicle: { roles: ['owner'], fn: parking.removeFreeVehicle, checks: ['text'] },
}

const isInteger = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100000000
const isText = (value: unknown) => typeof value === 'string' && value.length <= 500
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function valid(kind: string, value: unknown, db: parking.DB): boolean {
  switch (kind) {
    case 'text': return isText(value)
    case 'optionalText': return value == null || isText(value)
    case 'integer': return isInteger(value)
    case 'optionalInteger': return value == null || isInteger(value)
    case 'lookup': return value === 'plate' || value === 'qr' || value === 'search'
    case 'printKind': return value == null || value === 'slip' || value === 'receipt'
    case 'rates': return isObject(value) && Object.keys(value).length === db.categories.length && db.categories.every(({ id }) => {
      const rate = value[id]
      return isObject(rate) && isInteger(rate.firstHours) && Number(rate.firstHours) >= 1 && Number(rate.firstHours) <= 24
        && ['firstPaise', 'perHourPaise', 'capPaise'].every(k => isInteger(rate[k]))
    })
    case 'settings':
      return isObject(value) && (Object.keys(value).length === 7 || (Object.keys(value).length === 8 && 'gstin' in value))
        && ['siteName', 'operator', 'address', 'phone'].every(k => isText(value[k]))
        && Boolean(String(value.siteName).trim() && String(value.operator).trim())
        && isInteger(value.capacity) // 0 = number of spaces not tracked
        && (value.gstin === undefined || (typeof value.gstin === 'string' && /^([0-9]{2}[A-Z0-9]{13})?$/.test(value.gstin)))
        && typeof value.payAtEntry === 'boolean' && typeof value.cancelNeedsReason === 'boolean'
    default: return false
  }
}

type State = { version: number; db: parking.DB }
// The gate lock is read at most every 10 s, so open-gate requests stay fast.
let lockCache = { value: false, at: 0 }
async function gatesLocked() {
  if (Date.now() - lockCache.at > 10_000) lockCache = { value: Boolean((await state()).db.gateLock), at: Date.now() }
  return lockCache.value
}
const statePath = 'parking_runtime?id=eq.true'
const read = () => database<State[]>(statePath + '&select=db,version')

async function state() {
  const [current] = await read()
  if (current) return current
  const db = parking.seed(false)
  db.staff = [
    { id: 'ravi', name: 'Entry gate', role: 'attendant', gate: 'Entry' },
    { id: 'sunil', name: 'Exit gate', role: 'attendant', gate: 'Exit' },
    { id: 'owner', name: 'Owner', role: 'owner', gate: 'Office' },
  ]
  await database('parking_runtime?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ id: true, db }),
  })
  const [created] = await read()
  return created
}

function publishState(current: State, role: string) {
  const { offlineSeen: _seen, ...db } = current.db
  return { ...current, role, db: { ...db, razorpayEnabled: Boolean(razorpay), razorpayTest: Boolean(razorpay?.keyId.startsWith('rzp_test_')) } as parking.DB }
}

async function saveState(db: parking.DB, version: number) {
  const [saved] = await database<State[]>(statePath + '&version=eq.' + version, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ db, version: version + 1 }),
  })
  return saved
}

type PaymentRoute = 'create-order' | 'verify-payment' | 'check-payment' | 'switch-to-cash'

function isPaymentRoute(value: unknown): value is PaymentRoute {
  return value === 'create-order' || value === 'verify-payment' || value === 'check-payment' || value === 'switch-to-cash'
}

async function paymentRoute(action: PaymentRoute, payload: Record<string, unknown>, actor?: { role: string; label?: string }) {
  if (!razorpay) return reply({ error: 'Online checkout is unavailable.' }, 503)
  const token = payload.ticket_token
  const ticketId = payload.ticket_id
  if (!actor && (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token))) return reply({ error: 'Ticket access is required.' }, 401)
  if (actor && !['owner', 'exit', 'both', 'open'].includes(actor.role)) return reply({ error: 'This account cannot take payments.' }, 403)
  if (actor && (typeof ticketId !== 'string' || !/^T-(?:\d{6,}|[A-Z0-9]{2,4}-\d{4,6})$/.test(ticketId))) return reply({ error: 'Enter a valid parking ticket.' }, 400)
  const select = (db: parking.DB) => db.tickets.find(item => actor ? item.id === ticketId : item.token === token)
  // Fast "paid yet?" check from the gate: ask Razorpay about the open QR first; read the records only once money is there.
  if (action === 'check-payment' && actor && typeof payload.qr_id === 'string' && razorpayQrId.test(payload.qr_id) && Number.isSafeInteger(payload.amount) && (payload.amount as number) > 0) {
    const found = await capturedQrPayment(razorpay, payload.qr_id, payload.amount as number).catch(() => undefined)
    if (!found) return reply({ error: 'Razorpay has not confirmed a captured payment yet. Check again before paying or collecting cash.' }, 409)
  }
  const initial = await state()
  const ticket = select(initial.db)
  if (!ticket) return reply({ error: 'Ticket not found.' }, actor ? 404 : 401)

  if (action === 'create-order') {
    const { amount, currency, receipt } = payload
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 100 || currency !== 'INR' || receipt !== ticket.id) {
      return reply({ error: 'Supply the ticket receipt, INR, and an amount of at least 100 paise.' }, 400)
    }
    let providerOrder: { checkout: parking.OnlineCheckout; revision: number } | undefined
    for (let attempt = 0; attempt < 5; attempt++) {
      const { db, version } = attempt === 0 ? initial : await state()
      const fresh = select(db)
      if (!fresh || fresh.status !== 'inside') return reply({ error: 'This ticket is no longer awaiting payment.' }, 409)
      if (fresh.onlineCheckout) {
        const order = fresh.onlineCheckout
        if (order.amount !== amount) return reply({ error: 'The amount changed. Refresh this ticket before paying.' }, 409)
        return reply({ order_id: order.orderId, amount: order.amount, currency: order.currency, key_id: razorpay.keyId, link_url: order.linkUrl, upi_qr: order.upiQr, qr_image: order.qrImage })
      }
      if (!actor) return reply({ error: 'Ask the exit attendant to enable online payment for this ticket.' }, 409)
      const billedAt = Date.now()
      const bill = parking.billFor(db, fresh, billedAt)
      if (amount !== bill.duePaise || providerOrder && providerOrder.revision !== fresh.rev) {
        return reply({ error: 'The amount changed. Refresh this ticket before paying.' }, 409)
      }
      if (!providerOrder) {
        const receiptId = fresh.id + '-' + crypto.randomUUID().slice(0, 8)
        const quote = { amount, currency, receipt: receiptId, billedAt, totalPaise: bill.totalPaise } as const
        // UPI QR needs Razorpay's QR Codes feature on the account; without it, fall back to a payment link shown as a QR.
        let qrError = ''
        const qr = payload.upi_qr === true ? await createRazorpayQr(razorpay, amount, fresh.id).catch((error: unknown) => {
          qrError = error instanceof Error ? error.message : String(error)
          console.error('Razorpay UPI QR failed for ' + fresh.id + ': ' + qrError)
          return undefined
        }) : undefined
        // The POS asked for a direct UPI QR: never fall back to a payment link (its page asks the customer for a mobile number).
        if (payload.upi_qr === true && !qr) return reply({ error: 'UPI QR could not be made. ' + (qrError || 'Razorpay gave no reason.') }, 502)
        if (qr) {
          if (!razorpayQrId.test(qr.id) || qr.payment_amount !== amount || qr.status !== 'active' || !(qr.image_content || qr.image_url)) {
            throw new RazorpayServiceError('Razorpay returned an unexpected QR code.')
          }
          providerOrder = { revision: fresh.rev, checkout: { ...quote, orderId: qr.id, upiQr: qr.image_content, qrImage: qr.image_url } }
        } else if (payload.pos_qr === true || payload.upi_qr === true) {
          const link = await createRazorpayLink(razorpay, amount, receiptId, fresh.id)
          if (!razorpayLinkId.test(link.id) || link.amount !== amount || link.currency !== currency || link.reference_id !== receiptId
            || link.status !== 'created' || !/^https:\/\/(?:rzp\.io|razorpay\.com)\//.test(link.short_url)) {
            throw new RazorpayServiceError('Razorpay returned an unexpected payment link.')
          }
          providerOrder = { revision: fresh.rev, checkout: { ...quote, orderId: link.id, linkUrl: link.short_url } }
        } else {
          const created = await createRazorpayOrder(razorpay, amount, currency, receiptId)
          if (!razorpayOrderId.test(created.id) || created.amount !== amount || created.currency !== currency || created.receipt !== receiptId) {
            throw new RazorpayServiceError('Razorpay returned an unexpected order.')
          }
          providerOrder = { revision: fresh.rev, checkout: { ...quote, orderId: created.id } }
        }
      }
      fresh.onlineCheckout = providerOrder.checkout
      fresh.rev++
      const saved = await saveState(db, version)
      if (saved) return reply({ order_id: fresh.onlineCheckout.orderId, amount, currency, key_id: razorpay.keyId, link_url: fresh.onlineCheckout.linkUrl, upi_qr: fresh.onlineCheckout.upiQr, qr_image: fresh.onlineCheckout.qrImage, snapshot: publishState(saved, actor.role) })
    }
    return reply({ error: 'The ticket changed. Refresh and retry.' }, 409)
  }

  const order = ticket.onlineCheckout
  if (action === 'switch-to-cash') {
    if (!actor) return reply({ error: 'Gate access is required.' }, 403)
    if (!order || ticket.status !== 'inside') {
      return reply({ error: 'This payment cannot switch to cash. Check payment status first.' }, 409)
    }
    if (razorpayQrId.test(order.orderId)) {
      // UPI QR: close it so it can't be paid any more, then make sure nothing was paid before it closed.
      await closeRazorpayQr(razorpay, order.orderId)
      if (await capturedQrPayment(razorpay, order.orderId, order.amount)) {
        return reply({ error: 'The customer already paid this QR. Tap Check payment status.' }, 409)
      }
    } else if (!order.linkUrl) {
      // Checkout order (Razorpay window): allowed only if Razorpay has no captured payment for it.
      if (!razorpayOrderId.test(order.orderId)) return reply({ error: 'This payment cannot switch to cash. Check payment status first.' }, 409)
      if (await findCapturedPayment(razorpay, order.orderId)) {
        return reply({ error: 'Razorpay already received this payment. Tap Check payment status.' }, 409)
      }
    } else {
      if (!razorpayLinkId.test(order.orderId)) return reply({ error: 'This payment cannot switch to cash. Check payment status first.' }, 409)
      let link = await fetchRazorpayLink(razorpay, order.orderId)
      if (link.status === 'created') {
        try { link = await cancelRazorpayLink(razorpay, order.orderId) }
        catch { link = await fetchRazorpayLink(razorpay, order.orderId) }
      }
      if (link.id !== order.orderId || link.amount !== order.amount || link.currency !== order.currency || link.reference_id !== order.receipt
        || link.amount_paid !== 0 || link.payments?.length || !['cancelled', 'expired'].includes(link.status)) {
        return reply({ error: 'Razorpay has not confirmed that the link is closed and unpaid. Check payment status before collecting cash.' }, 409)
      }
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const { db, version } = await state()
      const fresh = select(db)
      if (!fresh || fresh.status !== 'inside' || fresh.onlineCheckout?.orderId !== order.orderId) {
        return reply({ error: 'The ticket changed. Reload it before collecting cash.' }, 409)
      }
      delete fresh.onlineCheckout
      fresh.rev++
      const saved = await saveState(db, version)
      if (saved) return reply({ revision: fresh.rev, snapshot: publishState(saved, actor.role) })
    }
    return reply({ error: 'The ticket changed. Check it before collecting cash.' }, 409)
  }
  if (action === 'verify-payment') {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = payload
    if (typeof razorpay_payment_id !== 'string' || !razorpayPaymentId.test(razorpay_payment_id)
      || typeof razorpay_order_id !== 'string' || !razorpayOrderId.test(razorpay_order_id)
      || typeof razorpay_signature !== 'string' || !razorpaySignature.test(razorpay_signature)) {
      return reply({ error: 'The payment ID, order ID and signature are required.' }, 400)
    }
    if (!order || razorpay_order_id !== order.orderId || !await verifyRazorpaySignature(razorpay.keySecret, order.orderId, razorpay_payment_id, razorpay_signature)) {
      return reply({ error: 'Payment signature or order did not match the parking ticket.' }, 400)
    }
  }
  if (!order) return reply({ error: 'This ticket has no online payment order.' }, 409)
  let providerOrderId = order.orderId
  let payment
  if (action === 'verify-payment') {
    payment = await fetchRazorpayPayment(razorpay, payload.razorpay_payment_id as string)
  } else if (razorpayQrId.test(order.orderId)) {
    const captured = await capturedQrPayment(razorpay, order.orderId, order.amount)
    if (captured) { payment = captured; providerOrderId = captured.order_id }
  } else if (order.linkUrl && razorpayLinkId.test(order.orderId)) {
    const link = await fetchRazorpayLink(razorpay, order.orderId)
    if (link.id !== order.orderId || link.amount !== order.amount || link.currency !== order.currency || link.reference_id !== order.receipt) {
      throw new RazorpayServiceError('Razorpay returned an unexpected payment link.')
    }
    const captured = link.payments?.find(item => item.status === 'captured')
    if (link.status === 'paid' && link.amount_paid === order.amount && link.order_id && razorpayOrderId.test(link.order_id)
      && captured && razorpayPaymentId.test(captured.payment_id)) {
      providerOrderId = link.order_id
      payment = await fetchRazorpayPayment(razorpay, captured.payment_id)
    }
  } else {
    payment = await findCapturedPayment(razorpay, order.orderId)
  }
  if (payment) console.log(`Payment timing: ${payment.id} paid at ${payment.created_at ? new Date(payment.created_at * 1000).toISOString() : '?'} · seen ${new Date().toISOString()} · ${payment.created_at ? Math.round(Date.now() / 1000 - payment.created_at) : '?'} s later · via ${actor ? 'gate check' : 'webhook/customer'}`)
  if (!payment || payment.status !== 'captured') return reply({ error: 'Razorpay has not confirmed a captured payment yet. Check again before paying or collecting cash.' }, 409)
  if (!razorpayPaymentId.test(payment.id) || (action === 'verify-payment' && payment.id !== payload.razorpay_payment_id)
    || payment.order_id !== providerOrderId || payment.amount !== order.amount || payment.currency !== order.currency || (payment.amount_refunded ?? 0) !== 0) {
    return reply({ error: 'Razorpay payment details did not match the parking order.' }, 400)
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const { db, version } = await state()
    const fresh = select(db)
    if (!fresh) return reply({ error: 'Ticket not found.' }, 404)
    const staff = db.staff.find(person => person.id === (actor?.role === 'owner' ? 'owner' : 'sunil'))!
    const settled = parking.settleOnlinePayment(db, { ...staff, name: actor?.label ?? 'Razorpay' }, fresh, order.orderId, payment.id)
    const saved = await saveState(db, version)
    if (saved) return reply({
      success: true, payment_id: payment.id, status: settled.status, revision: settled.rev,
      ...(actor ? { snapshot: publishState(saved, actor.role) } : {}),
    })
  }
  return reply({ error: 'Could not update the ticket. Check payment again before collecting cash.' }, 409)
}

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))))
}

/** UPI payments the operator confirmed: complete them when Razorpay confirms; flag them if Razorpay never does. */
async function reconcileUpi(onlyQr?: string) {
  if (!razorpay) return
  const { db, version } = await state()
  const pending = db.tickets.filter(t => t.upiCheck && t.onlineCheckout && (!onlyQr || t.upiCheck.orderId === onlyQr))
  if (!pending.length) return
  let changed = false
  const staff = db.staff.find(person => person.id === 'sunil')!
  for (const t of pending) {
    const order = t.onlineCheckout!
    const payment = await capturedQrPayment(razorpay, order.orderId, order.amount).catch(() => undefined)
    if (payment) { parking.settleOnlinePayment(db, { ...staff, name: 'Razorpay' }, t, order.orderId, payment.id); changed = true; console.log('UPI reconciled: ' + t.id + ' ' + payment.id) }
    else if (Date.now() - t.upiCheck!.at > 30 * 60_000 && !t.upiCheck!.flagged) {
      t.upiCheck!.flagged = true
      db.offlineIssues = [...(db.offlineIssues ?? []), { at: Date.now(), opId: 'upi-' + t.id, ticketId: t.id, device: t.upiCheck!.by,
        text: `${parking.prettyPlate(t.plate)}: UPI ${parking.rupees(order.amount)} was marked paid by ${t.upiCheck!.by} at the gate, but Razorpay has not received it after 30 minutes. Check the customer's payment.` }].slice(-500)
      changed = true
    }
  }
  if (changed) await saveState(db, version)
}

async function razorpayWebhook(request: Request, raw: string, body: Record<string, unknown>) {
  console.log('Razorpay webhook received: ' + String(body?.event))
  const secret = Deno.env.get('RAZORPAY_WEBHOOK_SECRET')
  const signature = request.headers.get('X-Razorpay-Signature') ?? ''
  if (!secret || !/^[a-f0-9]{64}$/.test(signature) || await hmacHex(secret, raw) !== signature) return reply({ error: 'Signature did not match.' }, 400)
  const payload = (body?.payload ?? {}) as Record<string, { entity?: Record<string, unknown> }>
  const qrId = (payload.qr_code?.entity?.id ?? (payload.payment?.entity?.notes as Record<string, unknown> | undefined)?.qr_code_id) as string | undefined
  if (typeof qrId !== 'string' || !razorpayQrId.test(qrId)) return reply({ ok: true, ignored: true })
  const { db } = await state()
  if (db.tickets.some(t => t.upiCheck?.orderId === qrId)) { await reconcileUpi(qrId); return reply({ ok: true, status: 'reconciled' }) }
  const ticket = db.tickets.find(t => t.onlineCheckout?.orderId === qrId && t.status === 'inside')
  if (!ticket) return reply({ ok: true, ignored: true })
  // Same checks as the gate's own "check payment": confirm with Razorpay, capture, then mark the ticket Paid.
  const result = await paymentRoute('check-payment', { ticket_token: ticket.token })
  return reply({ ok: true, status: result.status })
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405)
  try {
    const raw = await request.text()
    if (raw.length > 16000) return reply({ error: 'Request is too large.' }, 413)
    const body = JSON.parse(raw)
    const subroute = new URL(request.url).pathname.split('/').at(-1)
    // Keep-awake ping (a scheduled job calls this every few minutes so the first payment is not slow).
    if (body?.action === 'ping') { await reconcileUpi().catch(error => console.error('UPI reconcile failed: ' + error)); return reply({ ok: true }) }
    // Razorpay webhook: Razorpay tells us the moment a QR is paid, so the gate turns Paid without waiting for a poll.
    if (subroute === 'razorpay-webhook') return await razorpayWebhook(request, raw, body)
    const action = isPaymentRoute(subroute) ? subroute : body?.action
    const args = isPaymentRoute(subroute) ? [] : body?.args
    if (typeof action !== 'string' || !Array.isArray(args)) return reply({ error: 'Invalid request.' }, 400)
    if (isPaymentRoute(action) && (!body || typeof body !== 'object' || Array.isArray(body))) {
      return reply({ error: 'Send a JSON payment request.' }, 400)
    }
    if (isPaymentRoute(action) && body.ticket_token !== undefined && !request.headers.has('Authorization') && !request.headers.has('X-Device-Key')) {
      return await paymentRoute(action, body)
    }
    if (action === 'customer') {
      if (typeof args[0] !== 'string' || !/^[a-f0-9]{32}$/.test(args[0])) return reply({ error: 'Ticket not found.' }, 404)
      const [current] = await read()
      const ticket = current?.db.tickets.find(item => item.token === args[0])
      if (!ticket) return reply({ error: 'Ticket not found.' }, 404)
      const db = current.db
      const { plate, entryBy, exitBy, cancelledBy, cancelReason, ...safeTicket } = ticket
      return reply({ db: { ...db, razorpayEnabled: Boolean(razorpay), seq: 0, tickets: [{ ...safeTicket, plate: '••••' + plate.slice(-4) }], payments: db.payments.filter(payment => payment.ticketId === ticket.id).map(payment => ({ ...payment, by: '' })), tariffs: db.tariffs.filter(tariff => tariff.id === ticket.tariffId), audit: [], staff: [] } })
    }
    if (action === 'redeemOwnerCode') return await redeemOwnerCode(args)
    if (action === 'redeemPosCode') return await redeemPosCode(args)
    if (action === 'pairPosDevice') {
      const [code] = args
      if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code)) return reply({ error: 'Invalid POS setup link.' }, 400)
      const key = randomToken()
      const filter = new URLSearchParams({
        key_hash: 'eq.' + await hashCode(code), role: 'in.(entry,exit,both)', enabled: 'eq.false',
        pairing_expires_at: 'gt.' + new Date().toISOString(), select: 'id',
      })
      const [paired] = await database<Array<{ id: string }>>('parking_devices?' + filter, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ key_hash: await hashCode(key), enabled: true, pairing_expires_at: null }),
      })
      return paired ? reply({ result: { key } }) : reply({ error: 'This POS setup link has expired or was already used.' }, 400)
    }
    const authorization = request.headers.get('Authorization')
    let digest: string | undefined
    let signedIn: AuthUser | undefined
    let role: string
    let deviceLabel: string | undefined
    if (authorization?.startsWith('Bearer ')) {
      const response = await authRequest('user', {}, authorization.slice(7))
      if (!response.ok) return reply({ error: 'Sign in again to continue.' }, 401)
      signedIn = await response.json()
      const access = signedIn?.app_metadata
      if (!access?.parking_role || access.parking_enabled !== true) {
        return reply({ error: 'This login has no active parking access.' }, 403)
      }
      role = access.parking_role
      if (role === 'owner') {
        const session = verifiedSessionId(authorization.slice(7))
        if (!session || !access.parking_mobile || !await database<boolean>('rpc/parking_owner_session_valid', {
          method: 'POST', body: JSON.stringify({ owner_id: signedIn?.id, owner_session: session, owner_mobile: access.parking_mobile }),
        })) return reply({ error: 'Sign in again with your current Owner password.' }, 401)
      }
      if (isGate(role) && access.parking_mobile) {
        const session = verifiedSessionId(authorization.slice(7))
        if (!session || !await database<boolean>('rpc/parking_pos_session_valid', {
          method: 'POST', body: JSON.stringify({ operator_id: signedIn?.id, operator_session: session, operator_mobile: access.parking_mobile }),
        })) return reply({ error: 'Sign in again with your current PIN.' }, 401)
      }
    } else if (openAccess && !request.headers.get('X-Device-Key')) {
      role = 'open'
      deviceLabel = undefined
    } else {
      const key = request.headers.get('X-Device-Key') ?? ''
      if (!/^[a-f0-9]{64}$/.test(key)) return reply({ error: 'Sign in to continue.' }, 401)
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
      digest = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
      const [device] = await database<Array<{ role: string; label: string }>>('parking_devices?enabled=eq.true&select=role,label&key_hash=eq.' + digest)
      if (!device) return reply({ error: 'This setup code is invalid or revoked.' }, 401)
      role = device.role
      deviceLabel = device.label
    }

    // Gates locked by the Owner: only approved POS machines (device key) or signed-in accounts may use the gates.
    if (role === 'open' && await gatesLocked()) {
      return reply({ error: 'This POS is not set up yet. Scan its setup QR from the Owner dashboard (POS devices).', code: 'POS_NOT_APPROVED' }, 403)
    }
    if (action === 'setGateLock') {
      if (role !== 'owner') return reply({ error: 'Only the Owner can lock the gates.' }, 403)
      if (typeof args[0] !== 'boolean') return reply({ error: 'Choose on or off.' }, 400)
      for (let attempt = 0; attempt < 5; attempt++) {
        const { db, version } = await state()
        db.gateLock = args[0]
        lockCache = { value: args[0], at: Date.now() }
        db.audit.push({ id: crypto.randomUUID().slice(0, 8), at: Date.now(), by: 'Owner', kind: 'settings', text: args[0] ? 'Gates locked: only approved POS machines' : 'Gates unlocked: any device with the link' } as parking.DB['audit'][number])
        const saved = await saveState(db, version)
        if (saved) return reply({ result: args[0], snapshot: publishState(saved, role) })
      }
      return reply({ error: 'Try again.' }, 409)
    }
    if (isPaymentRoute(action)) return await paymentRoute(action, body, { role, label: signedIn?.app_metadata?.parking_label ?? deviceLabel ?? (role === 'open' ? 'Website · Exit gate' : role === 'owner' ? 'Owner' : undefined) })
    if (action === 'issueOwnerCode') {
      if (role !== 'owner') return reply({ error: 'Only the owner can issue a recovery code.' }, 403)
      const [mobile] = args
      if (!validMobile(mobile)) return reply({ error: 'Enter a valid Indian mobile number.' }, 400)
      const existing = (await authUsers()).find(user => user.email === loginAlias(mobile))
      if (existing && existing.app_metadata?.parking_role !== 'owner') return reply({ error: 'Use a mobile number that is separate from the POS account.' }, 409)
      const code = randomToken(16)
      const expiresAt = new Date(Date.now() + 30 * 60000).toISOString()
      await database('parking_owner_recovery?on_conflict=mobile', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ mobile, code_hash: await hashCode(code), expires_at: expiresAt, used_at: null }),
      })
      return reply({ result: { code, expiresAt } }, 201)
    }

    if (['listAccounts', 'issuePosCode', 'disablePosAccount', 'cancelPosSetup'].includes(action)) {
      if (role !== 'owner') return reply({ error: 'Only the owner can manage POS accounts.' }, 403)
      if (action === 'listAccounts') {
        const users = await authUsers()
        const accounts = users.filter(user => isGate(user.app_metadata?.parking_role)).map(user => ({
          id: user.id, mobile: user.app_metadata?.parking_mobile, role: user.app_metadata?.parking_role,
          label: user.app_metadata?.parking_label, enabled: user.app_metadata?.parking_enabled === true, pending: false,
        }))
        const pending = await database<PosSetup[]>('parking_pos_setup?select=mobile,label,gate,expires_at&used_at=is.null&expires_at=gt.' + encodeURIComponent(new Date().toISOString()))
        return reply({ result: [...accounts, ...pending.filter(item => !accounts.some(account => account.mobile === item.mobile)).map(item => ({
          id: item.mobile, mobile: item.mobile, role: item.gate, label: item.label, enabled: false, pending: true,
        }))] })
      }
      if (action === 'cancelPosSetup') {
        if (!validMobile(args[0])) return reply({ error: 'Choose a pending POS setup.' }, 400)
        await database('parking_pos_setup?' + new URLSearchParams({ mobile: 'eq.' + args[0], used_at: 'is.null' }), {
          method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ expires_at: new Date().toISOString() }),
        })
        return reply({ result: true })
      }
      if (action === 'disablePosAccount') {
        const [id] = args
        if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) return reply({ error: 'Choose a valid POS account.' }, 400)
        const response = await authRequest('admin/users/' + id)
        if (!response.ok) return reply({ error: 'POS account was not found.' }, 404)
        const account = await response.json() as AuthUser
        if (!isGate(account.app_metadata?.parking_role)) return reply({ error: 'Choose a POS account.' }, 400)
        const updated = await authRequest('admin/users/' + id, { method: 'PUT', body: JSON.stringify({
          app_metadata: { ...account.app_metadata, parking_enabled: false }, ban_duration: '876000h',
        }) })
        if (!updated.ok) throw new Error('Could not deactivate the POS account.')
        return reply({ result: true })
      }
      const [mobile, gate, label] = args
      if (!validMobile(mobile) || !isGate(gate) || typeof label !== 'string' || !label.trim() || label.trim().length > 80) {
        return reply({ error: 'Enter a valid mobile number, a gate and an operator name.' }, 400)
      }
      const existing = (await authUsers()).find(user => user.email === loginAlias(mobile))
      if (existing && (!isGate(existing.app_metadata?.parking_role) || existing.app_metadata?.parking_enabled !== true)) {
        return reply({ error: 'This mobile number is unavailable for POS setup.' }, 409)
      }
      const code = randomToken(8)
      const expiresAt = new Date(Date.now() + 30 * 60000).toISOString()
      await database('parking_pos_setup?on_conflict=mobile', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ mobile, label: label.trim(), gate, code_hash: await hashCode(code), expires_at: expiresAt, used_at: null }),
      })
      return reply({ result: { code, expiresAt } }, 201)
    }

    if (action === 'listDevices' || action === 'deactivateDevice' || action === 'issuePosDeviceLink') {
      if (role !== 'owner') return reply({ error: 'Only an owner can manage devices.' }, 403)
      if (action === 'issuePosDeviceLink') {
        const [label, gate] = args
        if (typeof label !== 'string' || !label.trim() || label.length > 80 || !isGate(gate)) return reply({ error: 'Enter a device name and choose its gate access.' }, 400)
        const code = randomToken()
        await database('parking_devices', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ key_hash: await hashCode(code), role: gate, label: label.trim(), enabled: true }),
        })
        return reply({ result: { code } }, 201)
      }
      if (action === 'listDevices') {
        const rows = await database<Array<{ id: string; label: string; role: string; enabled: boolean; key_hash: string; pairing_expires_at: string | null }>>(
          'parking_devices?select=id,label,role,enabled,key_hash,pairing_expires_at&order=role.asc,label.asc',
        )
        const now = new Date().toISOString()
        return reply({ result: rows.filter(row => !row.pairing_expires_at || row.pairing_expires_at > now)
          .map(({ key_hash, pairing_expires_at, ...row }) => ({ ...row, pending: Boolean(pairing_expires_at), current: key_hash === digest })) })
      }
      if (typeof args[0] !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(args[0])) {
        return reply({ error: 'Choose a valid gate device.' }, 400)
      }
      const changed = await database<Array<{ id: string }>>(
        'parking_devices?select=id&or=(enabled.eq.true,pairing_expires_at.not.is.null)&role=in.(entry,exit,both)&id=eq.' + args[0],
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ enabled: false, pairing_expires_at: null }) },
      )
      if (!changed.length) return reply({ error: 'This gate device is already inactive or unavailable.' }, 409)
      return reply({ result: true })
    }
    if (action === 'posSnapshot') {
      if (!digest || !isGate(role)) return reply({ error: 'This link does not grant POS access.' }, 403)
      return reply({ snapshot: publishState(await state(), role) })
    }
    if (action === 'snapshot') return reply({ snapshot: publishState(await state(), role) })
    if (action === 'syncOffline') {
      // Work a POS saved while it had no internet: recorded in order, at the time it happened, never twice.
      if (!(role === 'open' || isGate(role) || role === 'owner')) return reply({ error: 'This device cannot send gate records.' }, 403)
      const ops = args[0]
      const okOp = (op: unknown): op is OfflineOp => {
        if (!isObject(op)) return false
        const o = op as Record<string, unknown>
        return typeof o.opId === 'string' && /^[A-Za-z0-9-]{6,40}$/.test(o.opId)
          && ['entry', 'cash', 'exit', 'print'].includes(o.kind as string)
          && isInteger(o.at) && (o.at as number) > Date.now() - 14 * 24 * 3600_000 && (o.at as number) < Date.now() + 10 * 60_000
          && (o.staffId === 'ravi' || o.staffId === 'sunil')
          && typeof o.ticketId === 'string' && o.ticketId.length <= 30
          && (o.kind !== 'entry' || (offlineTicketId.test(o.ticketId) && typeof o.plate === 'string' && o.plate.length <= 20 && typeof o.category === 'string' && o.category.length <= 30 && typeof o.token === 'string' && /^[a-f0-9]{32}$/.test(o.token)))
          && (o.kind !== 'cash' || isInteger(o.paise))
          && (o.what == null || o.what === 'slip' || o.what === 'receipt')
          && (o.device == null || (typeof o.device === 'string' && o.device.length <= 40))
      }
      if (!Array.isArray(ops) || ops.length > 200 || !ops.every(okOp)) return reply({ error: 'Check the offline records and try again.' }, 400)
      for (let attempt = 0; attempt < 5; attempt++) {
        const { db, version } = await state()
        const seen = new Set(db.offlineSeen ?? [])
        const map: Record<string, string> = {}
        // Offline tickets that were already inside elsewhere: keep pointing them to the server ticket.
        for (const issue of db.offlineIssues ?? []) { const m = /\(([^)]+)\) but was already inside as (T-[A-Z0-9-]+)/.exec(issue.text); if (m) map[m[1]] = m[2] }
        const issues: NonNullable<parking.DB['offlineIssues']> = []
        const who = deviceLabel ?? (typeof ops[0]?.device === 'string' ? 'POS ' + ops[0].device : 'Website gate')
        for (const op of [...ops].sort((a, b) => a.at - b.at)) {
          if (seen.has(op.opId)) continue
          const audits = db.audit.length, pays = db.payments.length
          const problem = applyOp(db, op, map)
          for (const a of db.audit.slice(audits)) a.by = who + ' (offline)'
          for (const p of db.payments.slice(pays)) p.by = who
          for (const t of db.tickets) if (t.id === op.ticketId && op.kind === 'entry' && t.entryAt === op.at) t.entryBy = who
          seen.add(op.opId)
          if (problem) issues.push({ at: op.at, opId: op.opId, ticketId: op.ticketId, device: deviceLabel ?? op.device, text: problem })
        }
        db.offlineSeen = [...seen].slice(-3000)
        db.offlineIssues = [...(db.offlineIssues ?? []), ...issues].slice(-500)
        const saved = await saveState(db, version)
        if (saved) return reply({ result: { done: ops.map(op => op.opId), issues: issues.length }, snapshot: publishState(saved, role) })
      }
      return reply({ error: 'Another gate changed the records. Retrying shortly.' }, 409)
    }
    if (action === 'resolveOfflineIssue') {
      if (role !== 'owner') return reply({ error: 'Only the Owner can mark these checked.' }, 403)
      for (let attempt = 0; attempt < 5; attempt++) {
        const { db, version } = await state()
        const issue = (db.offlineIssues ?? []).find(i => i.opId === args[0])
        if (!issue) return reply({ error: 'Not found.' }, 404)
        issue.resolved = true
        const saved = await saveState(db, version)
        if (saved) return reply({ result: true, snapshot: publishState(saved, role) })
      }
      return reply({ error: 'Try again.' }, 409)
    }
    if (!Object.hasOwn(actions, action)) return reply({ error: 'Unknown parking action.' }, 400)
    const command = actions[action as keyof typeof actions]
    // Open access covers the gates only. Rates, settings and the free list need the signed-in Owner.
    const allowed = role === 'open' ? command.roles.includes('entry') || command.roles.includes('exit') : role === 'both'
      ? command.roles.includes('entry') || command.roles.includes('exit')
      : command.roles.includes(role)
    if (!allowed) return reply({ error: 'This device cannot perform that action.' }, 403)

    for (let attempt = 0; attempt < 5; attempt++) {
      const { db, version } = await state()
      if (action === 'createEntry' && args.length === 4) args.push(null)
      // Older devices send markPrinted(ticket) without saying slip or receipt; addFreeVehicle note is optional.
      if ((action === 'markPrinted' || action === 'addFreeVehicle') && args.length === command.checks.length - 1) args.push(null)
      if (args.length !== command.checks.length || !command.checks.every((kind, index) => valid(kind, args[index], db))) {
        return reply({ error: 'Check the parking details and try again.' }, 400)
      }
      const commandFn = command.fn as (db: parking.DB, staff: parking.Staff, ...args: unknown[]) => unknown
      const atExit = action === 'markPrinted'
        ? args[1] === 'receipt' || (args[1] == null && db.tickets.some(ticket => ticket.id === args[0] && ticket.status === 'exited'))
        : action !== 'createEntry'
      const staffId = role === 'owner' || (role === 'open' && command.roles.length === 1 && command.roles[0] === 'owner') ? 'owner'
        : role === 'exit' || ((role === 'both' || role === 'open') && atExit) ? 'sunil' : 'ravi'
      const result = parking.runAction(db, staffId, (snapshot, staff) => {
        // Who did it, as the Owner sees it in the Activity log: the POS's dashboard name, the Owner, or the open website.
        const label = signedIn?.app_metadata?.parking_label ?? deviceLabel ?? (role === 'open' ? (staff.id === 'owner' ? 'Owner' : staff.id === 'sunil' ? 'Website · Exit gate' : 'Website · Entry gate') : role === 'owner' ? 'Owner' : undefined)
        return commandFn(snapshot, label ? { ...staff, name: label } : staff, ...args)
      })
      const saved = await saveState(db, version)
      if (saved) return reply({ result, snapshot: publishState(saved, role) })
    }
    return reply({ error: 'Another gate changed the records. Refresh and try again.' }, 409)
  } catch (error) {
    if (error instanceof RazorpayServiceError) return reply({ error: error.message }, 500)
    if (error instanceof SyntaxError) return reply({ error: 'Invalid JSON.' }, 400)
    if (error instanceof parking.Refused) return reply({ error: error.message }, 409)
    return reply({ error: 'Parking server unavailable. Check the connection before retrying.' }, 503)
  }
})
