import { useEffect, useRef, useState } from 'react'
import { rupees } from './engine'
import { callParkingPayment } from './parking-api'
import { QR, ticketUrl } from './ui'

type Order = { order_id: string; amount: number; currency: 'INR'; key_id: string; link_url?: string }
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

export function RazorpayCheckout({ ticketId, token, amount, name, hasOrder, linkUrl, pos = false, onRevision }: {
  ticketId: string
  token: string
  amount: number
  name: string
  hasOrder: boolean
  linkUrl?: string
  pos?: boolean
  onRevision?: (revision: number) => void
}) {
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const [qrAmount, setQrAmount] = useState<number | null>(null)
  const [confirmCash, setConfirmCash] = useState(false)
  const ticket = pos ? { ticket_id: ticketId } : { ticket_token: token }

  useEffect(() => {
    if (!pos || !linkUrl) return
    let active = true
    let checking = false
    const timer = window.setInterval(async () => {
      if (checking || busyRef.current) return
      checking = true
      try {
        const result = await callParkingPayment<PaymentStatus>('check-payment', { ticket_id: ticketId })
        if (active) onRevision?.(result.revision)
      } catch { /* The manual check shows the provider response. */ }
      finally { checking = false }
    }, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [pos, linkUrl, ticketId, onRevision])

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
    onRevision?.(result.revision)
    setFailed(false)
    setMessage('Payment confirmed.')
  }

  async function check() {
    if (!begin()) return
    try { success(await callParkingPayment<PaymentStatus>('check-payment', ticket)) }
    catch (error) { showFailure(error) }
    finally { finish() }
  }

  async function switchToCash() {
    if (!begin()) return
    try {
      const result = await callParkingPayment<{ revision: number }>('switch-to-cash', ticket)
      onRevision?.(result.revision)
      setQrAmount(null)
      setConfirmCash(false)
      setMessage('Online payment closed. You can now collect cash.')
    } catch (error) { showFailure(error) }
    finally { finish() }
  }

  async function open() {
    if (!begin()) return
    try {
      const Checkout = pos ? null : await loadCheckout()
      const order = await callParkingPayment<Order>('create-order', { ...ticket, amount, currency: 'INR', receipt: ticketId, ...(pos ? { pos_qr: true } : {}) })
      if (!Checkout) {
        setQrAmount(order.amount)
        finish()
        return
      }
      let verifying = false
      const popup = new Checkout({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount,
        currency: order.currency,
        name,
        description: 'Parking ticket ' + ticketId,
        ...customerUpi,
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
    {!pos && linkUrl
      ? <a className="btn btn-primary" href={linkUrl} target="_blank" rel="noopener noreferrer">Pay with UPI · {rupees(amount)}</a>
      : qrAmount === null
      ? <button className="btn btn-primary" disabled={busy || amount < 100} onClick={() => void open()}>
        {busy ? 'Working…' : `${pos ? 'Show UPI payment QR' : 'Pay with UPI'} · ${rupees(amount)}`}
      </button>
      : <div className="card center payment-qr">
        <h2>Pay {rupees(qrAmount)} with UPI</h2>
        <div className="payment-qr-image"><QR text={ticketUrl(token)} size={240} /></div>
        <p>Scan with your phone camera, then tap <b>Pay with UPI</b>.</p>
        <button className="btn btn-ghost" disabled={busy} onClick={() => setQrAmount(null)}>Hide QR</button>
      </div>}
    {(hasOrder || qrAmount !== null) && <button className="btn btn-ghost" disabled={busy} onClick={() => void check()}>Check payment status</button>}
    {pos && linkUrl && (confirmCash
      ? <div className="card stack">
        <p>Close this UPI link before collecting cash. If the customer sees a debit or pending payment, check payment status first.</p>
        <div className="row2">
          <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmCash(false)}>Keep UPI</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void switchToCash()}>{busy ? 'Checking…' : 'Close link'}</button>
        </div>
      </div>
      : <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmCash(true)}>Switch to cash</button>)}
    {message && <p className={failed ? 'msg bad' : 'msg info'} role={failed ? 'alert' : 'status'}>{message}</p>}
  </section>
}
