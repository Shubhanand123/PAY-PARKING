import { useRef, useState } from 'react'
import { rupees } from './engine'
import { callParkingPayment } from './parking-api'

type Order = { order_id: string; amount: number; currency: 'INR'; key_id: string }
type Signature = { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }
type PaymentStatus = { success: boolean; status: 'paid' | 'exited'; revision: number }
type CheckoutOptions = {
  key: string
  order_id: string
  amount: number
  currency: 'INR'
  name: string
  description: string
  hidden?: { contact: boolean; email: boolean }
  config?: {
    display: {
      blocks: Record<string, { name: string; instruments: { method: 'upi' }[] }>
      sequence: string[]
      preferences: { show_default_blocks: boolean }
    }
  }
  handler: (response: Signature) => void
  modal: { ondismiss: () => void }
}
type CheckoutInstance = { open: () => void; on: (event: 'payment.failed', handler: () => void) => void }
type Checkout = new (options: CheckoutOptions) => CheckoutInstance
type RazorpayWindow = Window & { Razorpay?: Checkout }

const customerUpi: Pick<CheckoutOptions, 'hidden' | 'config'> = {
  hidden: { contact: true, email: true },
  config: {
    display: {
      blocks: { upi: { name: 'Pay via UPI', instruments: [{ method: 'upi' }] } },
      sequence: ['block.upi'],
      preferences: { show_default_blocks: false },
    },
  },
}

let loading: Promise<Checkout> | undefined

function loadCheckout() {
  const existing = (window as RazorpayWindow).Razorpay
  if (existing) return Promise.resolve(existing)
  if (!loading) {
    loading = new Promise<Checkout>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://checkout.razorpay.com/v1/checkout.js'
      script.async = true
      const failed = () => {
        script.remove()
        reject(new Error('Razorpay Checkout could not load. Check the connection and try again.'))
      }
      const timeout = window.setTimeout(failed, 10_000)
      script.onload = () => {
        clearTimeout(timeout)
        const checkout = (window as RazorpayWindow).Razorpay
        if (checkout) resolve(checkout)
        else failed()
      }
      script.onerror = () => { clearTimeout(timeout); failed() }
      document.head.append(script)
    }).catch(error => { loading = undefined; throw error })
  }
  return loading
}

export function RazorpayCheckout({ ticketId, token, amount, name, hasOrder, onPaid }: {
  ticketId: string
  token?: string
  amount: number
  name: string
  hasOrder: boolean
  onPaid?: (revision: number) => void
}) {
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const ticket = token ? { ticket_token: token } : { ticket_id: ticketId }

  function begin() {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    setMessage('')
    setFailed(false)
    return true
  }

  function finish() {
    busyRef.current = false
    setBusy(false)
  }

  function showFailure(error: unknown) {
    setFailed(true)
    setMessage(error instanceof Error ? error.message : 'Could not verify the payment. Check payment status before retrying.')
  }

  function success(result: PaymentStatus) {
    onPaid?.(result.revision)
    setFailed(false)
    setMessage('Payment confirmed.')
  }

  async function check() {
    if (!begin()) return
    try { success(await callParkingPayment<PaymentStatus>('check-payment', ticket)) }
    catch (error) { showFailure(error) }
    finally { finish() }
  }

  async function open() {
    if (!begin()) return
    try {
      const Checkout = await loadCheckout()
      const order = await callParkingPayment<Order>('create-order', { ...ticket, amount, currency: 'INR', receipt: ticketId })
      let verifying = false
      const popup = new Checkout({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount,
        currency: order.currency,
        name,
        description: 'Parking ticket ' + ticketId,
        ...(token ? customerUpi : {}),
        modal: { ondismiss: () => {
          if (verifying) return
          setMessage(previous => previous || 'Checkout closed. Resume payment or check its status.')
          finish()
        } },
        handler: async ({ razorpay_payment_id, razorpay_order_id, razorpay_signature }) => {
          if (verifying) return
          verifying = true
          setMessage('Verifying payment…')
          setFailed(false)
          try { success(await callParkingPayment<PaymentStatus>('verify-payment', { ...ticket, razorpay_payment_id, razorpay_order_id, razorpay_signature })) }
          catch (error) { showFailure(error) }
          finally { finish() }
        },
      })
      popup.on('payment.failed', () => {
        setFailed(true)
        setMessage('Payment failed. Retry in Razorpay or close checkout and check the payment status.')
      })
      popup.open()
    } catch (error) {
      showFailure(error)
      finish()
    }
  }

  return <section className="stack razorpay-actions" aria-label="Online payment">
    <button className="btn btn-primary" disabled={busy || amount < 100} onClick={() => void open()}>
      {busy ? 'Working…' : `${token ? 'Pay with UPI' : hasOrder ? 'Resume online payment' : 'Pay online'} · ${rupees(amount)}`}
    </button>
    {hasOrder && <button className="btn btn-ghost" disabled={busy} onClick={() => void check()}>Check payment status</button>}
    {message && <p className={failed ? 'msg bad' : 'msg info'} role={failed ? 'alert' : 'status'}>{message}</p>}
  </section>
}
