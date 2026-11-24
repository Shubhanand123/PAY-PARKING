import { useEffect, useRef, useState } from 'react'
import { dur, prettyPlate, rupees, type Ticket } from './engine'
import { callParkingPayment } from './parking-api'
import { chime } from './done'
import { Ico, QR } from './ui'

type Order = { order_id: string; amount: number; link_url?: string; upi_qr?: string; qr_image?: string }
type PaymentStatus = { success: boolean; status: 'paid' | 'exited'; revision: number }
type Code = { text?: string; image?: string; link?: boolean }

const NO_QR = 'Direct UPI QR is not switched on for this Razorpay account, so no QR was shown. Ask Razorpay support to enable "QR Codes". Take cash for now.'
const VALID_MS = 30 * 60_000 // Razorpay closes the QR after 30 minutes (close_by on the server)

/**
 * Q9 "Scan & pay" at the exit gate: Razorpay's single-use UPI QR for the exact amount, a 30-minute timer,
 * an automatic payment check every 3 s, a chime when the money arrives, and Make new QR once it expires.
 */
export function PosPay({ t, amount, vehicle, paid, onRevision, onDone, onCash, onBack }: {
  t: Ticket
  amount: number
  vehicle: string
  paid: boolean
  onRevision: (revision: number) => void
  onDone: () => void      // payment received and shown: open the receipt
  onCash: () => void      // QR closed: back to the bill to take cash
  onBack: () => void      // back to the bill; the QR stays open and shows again on return
}) {
  const order = t.onlineCheckout
  const fromTicket: Code | null = order?.upiQr || order?.qrImage ? { text: order.upiQr, image: order.qrImage } : null
  const linkOnly = Boolean(order?.linkUrl && !order.upiQr && !order.qrImage)
  const [code, setCode] = useState<Code | null>(fromTicket)
  const [madeAt, setMadeAt] = useState(order?.billedAt ?? Date.now())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [confirmCash, setConfirmCash] = useState(false)
  const [now, setNow] = useState(Date.now())
  const busyRef = useRef(false)
  const started = useRef(false)

  useEffect(() => { if (fromTicket) setCode(fromTicket) }, [order?.upiQr, order?.qrImage, order?.linkUrl]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (order?.billedAt) setMadeAt(order.billedAt) }, [order?.billedAt])
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i) }, [])

  const left = Math.max(0, madeAt + VALID_MS - now)
  const expired = Boolean(code) && left === 0 && !paid

  async function run<T>(fn: () => Promise<T>) {
    if (busyRef.current) return undefined
    busyRef.current = true; setBusy(true); setMessage('')
    try { return await fn() }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Something went wrong. Check the payment status.'); return undefined }
    finally { busyRef.current = false; setBusy(false) }
  }

  const create = () => run(async () => {
    const o = await callParkingPayment<Order>('create-order', { ticket_id: t.id, amount, currency: 'INR', receipt: t.id, upi_qr: true })
    if (!o.upi_qr && !o.qr_image) {
      // Razorpay gave a payment link (its page asks for a mobile number), not a UPI QR: close it and say why.
      if (o.link_url) await callParkingPayment('switch-to-cash', { ticket_id: t.id }).catch(() => undefined)
      throw new Error(NO_QR)
    }
    setCode({ text: o.upi_qr, image: o.qr_image })
    setMadeAt(Date.now())
  })

  // Open the pay screen: reuse the open QR, or make one for the exact amount.
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (linkOnly) void run(async () => { await callParkingPayment('switch-to-cash', { ticket_id: t.id }); throw new Error(NO_QR) })
    else if (!order) void create()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Check with Razorpay every 3 s, so the screen turns Paid even without a tap.
  useEffect(() => {
    if (!code || paid) return
    let live = true
    const i = setInterval(async () => {
      if (busyRef.current) return
      try { const r = await callParkingPayment<PaymentStatus>('check-payment', { ticket_id: t.id }); if (live) onRevision(r.revision) } catch { /* not paid yet */ }
    }, 3000)
    return () => { live = false; clearInterval(i) }
  }, [code, paid, t.id, onRevision])

  // Money received: chime, show it for a moment, then open the receipt.
  useEffect(() => {
    if (!paid) return
    chime()
    const i = setTimeout(onDone, 1700)
    return () => clearTimeout(i)
  }, [paid]) // eslint-disable-line react-hooks/exhaustive-deps

  const check = () => run(async () => { const r = await callParkingPayment<PaymentStatus>('check-payment', { ticket_id: t.id }); onRevision(r.revision) })
  const close = () => run(async () => { const r = await callParkingPayment<{ revision: number }>('switch-to-cash', { ticket_id: t.id }); onRevision(r.revision); return true })
  const toCash = async () => { if (!code) { onCash(); return } if (await close()) onCash() }
  const remake = async () => { if (await close()) { setCode(null); await create() } }

  const mm = String(Math.floor(left / 60000)).padStart(2, '0'), ss = String(Math.floor(left / 1000) % 60).padStart(2, '0')
  const state = paid ? 'paid' : expired ? 'expired' : code ? 'waiting' : 'making'

  return (
    <section className={'q9 q9-' + state} aria-label="Pay by UPI">
      {!paid && <div className="q9-top">
        <button className="btn btn-ghost fit" disabled={busy} onClick={onBack}><Ico n="back" size={18} /> Back to bill</button>
        <button className="btn btn-ghost fit danger-text" disabled={busy || !code} onClick={() => setConfirmCash(true)}><Ico n="x" size={16} /> Cancel QR</button>
      </div>}
      <div className="q9-due">
        <div><span className="q9-lab">Amount due</span><b className="q9-amt num">{rupees(amount)}</b></div>
        <div className="q9-veh">
          <span className="ind-plate sm"><i />{prettyPlate(t.plate)}</span>
          <small>{vehicle} · {dur(now - t.entryAt)} · {t.id}</small>
        </div>
      </div>

      <div className="q9-card">
        <div className={'q9-code' + (code?.image && !code.text ? ' poster' : '')}>
          {code?.text ? <QR text={code.text} size={320} level="H" /> : code?.image ? <img src={code.image} alt="UPI payment QR code" /> : <div className="q9-ph" />}
          {code?.text && !code.link && <span className="q9-mark"><Ico n="p" size={26} /></span>}
          {state === 'waiting' && !(code?.image && !code.text) && <i className="q9-beam" />}
          {state === 'paid' && <div className="q9-over ok"><span className="q9-tick"><Ico n="check" size={40} /></span><b>{rupees(amount)} received</b><small>Opening the receipt…</small></div>}
          {state === 'expired' && <div className="q9-over"><b>QR expired</b><small>It was valid for 30 minutes. Make a new one for the amount due now.</small>
            <button className="btn btn-primary fit" disabled={busy} onClick={() => void remake()}><Ico n="qr" /> Make new QR</button></div>}
          {state === 'making' && <div className="q9-over"><small>{busy ? 'Making the QR…' : 'No UPI QR. See the message below.'}</small>{!busy && <button className="btn btn-primary fit" onClick={() => void create()}>Try again</button>}</div>}
        </div>
        <div className="q9-timer">
          <div className="q9-tl"><span>QR valid for</span><b className="num">{mm}:{ss}</b></div>
          <div className="q9-bar"><i style={{ transform: `scaleX(${left / VALID_MS})` }} /></div>
        </div>
      </div>

      <p className={'q9-status ' + state} role="status">
        {state === 'paid' ? 'Payment received' : state === 'expired' ? 'QR expired' : state === 'making' ? 'Getting the QR ready' : <><span className="q9-dots"><i /><i /><i /></span>Waiting for payment</>}
      </p>
      <ol className="q9-steps">
        <li><span><Ico n="key" /></span>Open any UPI app</li>
        <li><span><Ico n="scan" /></span>Scan the code</li>
        <li><span><Ico n="check" /></span>Approve {rupees(amount)}</li>
      </ol>
      {code?.link && <p className="tiny muted center">Scan with the phone camera and pay on Razorpay.</p>}
      {code?.image && !paid && <a className="btn btn-primary btn-lg" href={code.image} target="_blank" rel="noopener noreferrer"><Ico n="qr" /> Open QR on Razorpay screen</a>}

      <div className="q9-actions">
        {state === 'expired' && <button className="btn btn-xl q9-dark" disabled={busy} onClick={() => void remake()}><Ico n="qr" /> Make new QR · {rupees(amount)}</button>}
        {!paid && (confirmCash
          ? <div className="card stack">
            <p className="small">Close this QR before taking cash. If the customer says money was debited, tap Check now first.</p>
            <div className="row2">
              <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmCash(false)}>Keep QR</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void toCash()}>{busy ? 'Checking…' : 'Close QR · take cash'}</button>
            </div>
          </div>
          : <button className="btn btn-ghost btn-lg" disabled={busy} onClick={() => setConfirmCash(true)}><Ico n="cash" /> Switch to cash</button>)}
        {message && <p className="msg bad" role="alert">{message}</p>}
        {!paid && <p className="q9-foot">Checked automatically every 3 s · <button className="link" disabled={busy} onClick={() => void check()}>Check now</button></p>}
      </div>
    </section>
  )
}
