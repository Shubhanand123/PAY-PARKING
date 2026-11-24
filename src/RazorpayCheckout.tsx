import { useEffect, useRef, useState } from 'react'
import { rupees } from './engine'
import { callParkingPayment } from './parking-api'
import { Ico, QR } from './ui'

type Order = { order_id: string; amount: number; currency: 'INR'; key_id: string; link_url?: string; upi_qr?: string; qr_image?: string }
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
  config?: { display: { blocks: Record<string, { name: string; instruments: { method: string; flows?: string[] }[] }>; sequence: string[]; preferences: { show_default_blocks: boolean } } }
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

export function RazorpayCheckout({ ticketId, token, amount, name, hasOrder, linkUrl, upiQr, qrImage, test = false, pos = false, onRevision }: {
  ticketId: string
  token: string
  amount: number
  name: string
  hasOrder: boolean
  linkUrl?: string
  upiQr?: string
  qrImage?: string
  test?: boolean
  pos?: boolean
  onRevision?: (revision: number) => void
}) {
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  // POS shows a big QR: Razorpay's UPI QR when available, otherwise the Razorpay payment link as a QR.
  const fromProps = upiQr || qrImage ? { text: upiQr, image: qrImage } : pos && linkUrl ? { text: linkUrl, link: true } : null
  const [qr, setQr] = useState<{ text?: string; image?: string; link?: boolean } | null>(fromProps)
  useEffect(() => { if (fromProps) setQr(fromProps) }, [upiQr, qrImage, linkUrl]) // eslint-disable-line react-hooks/exhaustive-deps
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
    }, 3000)
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
  function finish() {
    busyRef.current = false
    setBusy(false)
    // Razorpay's window can leave the page locked; always give scrolling back.
    document.body.style.overflow = ''
    document.documentElement.style.overflow = ''
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
      setQr(null)
      setConfirmCash(false)
      setMessage('Online payment closed. You can now collect cash.')
    } catch (error) { showFailure(error) }
    finally { finish() }
  }

  /** Razorpay UPI QR for the exact amount, shown big on the POS. The server confirms the payment with Razorpay. */
  async function showUpiQr() {
    if (!begin()) return
    try {
      const order = await callParkingPayment<Order>('create-order', { ...ticket, amount, currency: 'INR', receipt: ticketId, upi_qr: true })
      if (!order.upi_qr && !order.qr_image && !order.link_url) throw new Error('Another online payment is open for this ticket. Check its status or switch to cash first.')
      setQr(order.upi_qr || order.qr_image ? { text: order.upi_qr, image: order.qr_image } : { text: order.link_url, link: true })
    } catch (error) { showFailure(error) }
    finally { finish() }
  }

  /** Open Razorpay Standard Checkout (customer's own phone, or test mode). The POS shows a UPI QR instead. */
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

  if (pos && qr) return <section className="stack razorpay-actions" aria-label="UPI payment">
    <div className="card center upi-qr">
      <div className="upi-amount">{rupees(amount)}</div>
      <div className="upi-qr-box">
        {qr.text ? <QR text={qr.text} size={340} /> : <img src={qr.image} alt="UPI payment QR code" />}
      </div>
      <p className="upi-hint">{qr.link ? 'Scan with phone camera · pay on Razorpay' : 'Scan with any UPI app · GPay · PhonePe · Paytm'}</p>
      <p className="upi-wait" role="status"><span className="upi-dot" /> Waiting for payment… turns Paid by itself</p>
      {test && !qr.link && <p className="tiny muted">Test mode: real UPI apps cannot pay a test QR. Use Card / other below to test, or switch to live keys.</p>}
      {test && qr.link && <p className="tiny muted">Test mode: on the Razorpay page use UPI success@razorpay or card 4111 1111 1111 1111.</p>}
    </div>
    <button className="btn btn-ghost" disabled={busy} onClick={() => void check()}>Check payment status</button>
    {confirmCash
      ? <div className="card stack">
        <p>Close this QR before taking cash. If the customer says money was debited, check payment status first.</p>
        <div className="row2">
          <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmCash(false)}>Keep QR</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void switchToCash()}>{busy ? 'Checking…' : 'Close QR · take cash'}</button>
        </div>
      </div>
      : <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmCash(true)}>Switch to cash</button>}
    {message && <p className={failed ? 'msg bad' : 'msg info'} role={failed ? 'alert' : 'status'}>{message}</p>}
  </section>

  if (!pos && qr) return <p className="msg info">Scan the UPI QR on the attendant's screen to pay.</p>

  return <section className="stack razorpay-actions" aria-label="Online payment">
    {pos && !hasOrder && !test
      // POS: Razorpay's own UPI QR for the exact amount, shown big here; the ticket turns Paid once Razorpay confirms.
      ? <button className="btn btn-primary btn-xl" disabled={busy || amount < 100} onClick={() => void showUpiQr()}>
        <Ico n="qr" size={24} /> {busy ? 'Working…' : <>Pay by UPI · {rupees(amount)}</>}
      </button>
      : linkUrl
        ? <a className="btn btn-primary btn-xl" href={linkUrl} target="_blank" rel="noopener noreferrer">Open Razorpay payment · {rupees(amount)}</a>
        : <button className="btn btn-primary btn-xl" disabled={busy || amount < 100} onClick={() => void open()}>
          {busy ? 'Working…' : <>{hasOrder ? 'Resume Razorpay' : 'Pay online · Razorpay'} · {rupees(amount)}</>}
        </button>}
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
