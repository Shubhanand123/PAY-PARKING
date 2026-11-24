export type RazorpayCredentials = { keyId: string; keySecret: string }
export type RazorpayOrder = { id: string; amount: number; currency: string; receipt: string }
type RazorpayLink = {
  id: string; amount: number; amount_paid: number; currency: string; reference_id: string; short_url: string; status: string
  order_id?: string; payments?: { payment_id: string; status: string }[] | null
}
export type RazorpayPayment = {
  id: string
  order_id: string
  amount: number
  currency: string
  status: string
  amount_refunded?: number
}

export const razorpayOrderId = /^order_[A-Za-z0-9]+$/
export const razorpayLinkId = /^plink_[A-Za-z0-9]+$/
export const razorpayPaymentId = /^pay_[A-Za-z0-9]+$/
export const razorpayQrId = /^qr_[A-Za-z0-9]+$/
export const razorpaySignature = /^[a-f0-9]{64}$/i

export class RazorpayServiceError extends Error {}

async function request<T>(credentials: RazorpayCredentials, path: string, body?: object): Promise<T> {
  try {
    const response = await fetch('https://api.razorpay.com/v1/' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: 'Basic ' + btoa(credentials.keyId + ':' + credentials.keySecret),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) throw new RazorpayServiceError('Razorpay could not process the request. Please retry.')
    return await response.json() as T
  } catch {
    throw new RazorpayServiceError('Razorpay could not process the request. Please retry.')
  }
}

export function createRazorpayOrder(credentials: RazorpayCredentials, amount: number, currency: 'INR', receipt: string) {
  return request<RazorpayOrder>(credentials, 'orders', { amount, currency, receipt })
}

export function createRazorpayLink(credentials: RazorpayCredentials, amount: number, referenceId: string, ticketId: string) {
  return request<RazorpayLink>(credentials, 'payment_links', {
    amount, currency: 'INR', reference_id: referenceId, description: 'Parking ticket ' + ticketId,
    upi_link: credentials.keyId.startsWith('rzp_live_'), accept_partial: false,
    notify: { sms: false, email: false }, reminder_enable: false,
    expire_by: Math.floor(Date.now() / 1000) + 1800,
  })
}

export function fetchRazorpayLink(credentials: RazorpayCredentials, linkId: string) {
  return request<RazorpayLink>(credentials, 'payment_links/' + linkId)
}

export function cancelRazorpayLink(credentials: RazorpayCredentials, linkId: string) {
  return request<RazorpayLink>(credentials, 'payment_links/' + linkId + '/cancel', {})
}

type RazorpayQr = { id: string; status: string; payment_amount: number; image_content?: string; image_url?: string }

/** Single-use UPI QR for an exact amount. Any UPI app can pay it (live mode only; test-mode QRs cannot be paid from real apps). */
export function createRazorpayQr(credentials: RazorpayCredentials, amount: number, ticketId: string) {
  return request<RazorpayQr>(credentials, 'payments/qr_codes', {
    type: 'upi_qr', name: 'Parking', usage: 'single_use', fixed_amount: true, payment_amount: amount,
    description: 'Parking ticket ' + ticketId, close_by: Math.floor(Date.now() / 1000) + 1800,
  })
}

export async function capturedQrPayment(credentials: RazorpayCredentials, qrId: string, amount: number) {
  const payments = await request<{ items: RazorpayPayment[] }>(credentials, 'payments/qr_codes/' + qrId + '/payments')
  return payments.items.find(payment => payment.status === 'captured' && payment.amount === amount)
}

export async function closeRazorpayQr(credentials: RazorpayCredentials, qrId: string) {
  try { await request<RazorpayQr>(credentials, 'payments/qr_codes/' + qrId + '/close', {}) } catch { /* already closed or expired */ }
}

export function fetchRazorpayPayment(credentials: RazorpayCredentials, paymentId: string) {
  return request<RazorpayPayment>(credentials, 'payments/' + paymentId)
}

export async function findCapturedPayment(credentials: RazorpayCredentials, orderId: string) {
  const payments = await request<{ items: RazorpayPayment[] }>(credentials, 'orders/' + orderId + '/payments')
  return payments.items.find(payment => payment.status === 'captured')
}

export async function verifyRazorpaySignature(secret: string, storedOrderId: string, paymentId: string, signature: string) {
  if (!razorpaySignature.test(signature)) return false
  const input = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', input.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16)
  return crypto.subtle.verify('HMAC', key, bytes, input.encode(storedOrderId + '|' + paymentId))
}
