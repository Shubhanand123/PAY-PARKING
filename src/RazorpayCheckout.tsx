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
  theme?: { color: string }
  prefill?: { contact?: string; email?: string }
  handler: (response: Signature) => void
  modal: { ondismiss: () => void }
}
type CheckoutInstance = { open: () => void; on: (event: 'payment.failed', handler: () => void) => void }
type Checkout = new (options: CheckoutOptions) => CheckoutInstance
type RazorpayWindow = Window & { Razorpay?: Checkout }

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
  const [showQr, setShowQr] = useState(false)
  const [confirmCash, setConfirmCash] = useState(false)
  const ticket = pos ? { ticket_id: ticketId } : { ticket_token: token }

  // At the gate, keep checking an open order so the screen turns Paid even if the customer paid on their own phone.
  useEffect(() => {
    if (!pos || !hasOrder) return
    let active = true
    let checking = false
    const timer = window.setInterval(async () => {
      if (checking || busyRef.current) return
      checking = true
      try {
        const result = await callParkingPayment<PaymentStatus>('check-payment', { ticket_id: ticketId })
        if (active) onRevision?.(result.revision)
      } catch { /* not paid yet; the manual check shows the reason */ }
      finally { checking = false }
    }, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [pos, hasOrder, ticketId, onRevision])

  function begin() {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    setMessage('')
    setFailed(false)
    return true
  }
  function finish() { busyRef.current = false; setBusy(false) }
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
      setShowQr(false)
      setConfirmCash(false)
      setMessage('Online payment closed. You can now collect cash.')
    } catch (error) { showFailure(error) }
    finally { finish() }
  }

  /** Lock the amount with a Razorpay order without opening the window, so the customer can pay from the ticket QR. */
  async function customerPhone() {
    if (!begin()) return
    try {
      await callParkingPayment<Order>('create-order', { ...ticket, amount, currency: 'INR', receipt: ticketId })
      setShowQr(true)
    } catch (error) { showFailure(error) }
    finally { finish() }
  }

  /** Open Razorpay Standard Checkout (all payment methods; test mode shows Razorpay's test screens). */
  async function open() {
    if (!begin()) return
    try {
      const Checkout = await loadCheckout()
      const order = await callParkingPayment<Order>('create-order', { ...ticket, amount, currency: 'INR', receipt: ticketId })
      if (order.link_url) {
        // An older UPI-link order is open for this ticket: continue on Razorpay's hosted page.
        window.open(order.link_url, '_blank', 'noopener')
        setMessage('Razorpay payment page opened. The ticket turns Paid once Razorpay confirms.')
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
        theme: { color: '#16245c' },
        modal: { ondismiss: () => {
          if (verifying) return
          setMessage(previous => previous || 'Razorpay closed. Pay again, check the status, or switch to cash.')
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
        setMessage('Payment failed. Try again in the Razorpay window, or close it and check the payment status.')
      })
      popup.open()
    } catch (error) {
      showFailure(error)
      finish()
    }
  }

  return <section className="stack razorpay-actions" aria-label="Online payment">
    <button className="btn btn-primary btn-xl" disabled={busy || amount < 100} onClick={() => void open()}>
      {busy ? 'Working…' : <>{hasOrder ? 'Resume Razorpay' : 'Pay online · Razorpay'} · {rupees(amount)}</>}
    </button>
    {pos && !showQr && !linkUrl && <button className="btn btn-ghost" disabled={busy} onClick={() => void customerPhone()}>Customer pays on their phone</button>}
    {pos && showQr && <div className="card center payment-qr">
      <h2>Customer scans to pay {rupees(amount)}</h2>
      <div className="payment-qr-image"><QR text={ticketUrl(token)} size={240} /></div>
      <p>They open their ticket and pay with Razorpay. This screen turns Paid by itself.</p>
      <button className="btn btn-ghost" disabled={busy} onClick={() => setShowQr(false)}>Hide QR</button>
    </div>}
    {hasOrder && <button className="btn btn-ghost" disabled={busy} onClick={() => void check()}>Check payment status</button>}
    {pos && hasOrder && (confirmCash
      ? <div className="card stack">
        <p>Close the online payment before taking cash. If the customer says money was debited, check payment status first.</p>
        <div className="row2">
          <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmCash(false)}>Keep online</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void switchToCash()}>{busy ? 'Checking…' : 'Switch to cash'}</button>
        </div>
      </div>
      : <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmCash(true)}>Switch to cash</button>)}
    {message && <p className={failed ? 'msg bad' : 'msg info'} role={failed ? 'alert' : 'status'}>{message}</p>}
  </section>
}
