export type RazorpayCredentials = { keyId: string; keySecret: string }
export type RazorpayOrder = { id: string; amount: number; currency: string; receipt: string }
export type RazorpayPayment = {
  id: string
  order_id: string
  amount: number
  currency: string
  status: string
  amount_refunded?: number
}

export const razorpayOrderId = /^order_[A-Za-z0-9]+$/
export const razorpayPaymentId = /^pay_[A-Za-z0-9]+$/
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
