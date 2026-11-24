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
export function PosPay({ t, amount, vehicle, lines = [], paid, onRevision, onDone, onCash, onBack }: {
  t: Ticket
  amount: number
  vehicle: string
  lines?: { label: string; paise: number }[]  // the bill, shown above the QR (design 7)
  paid: boolean
  onRevision: (revision: number) => void
  onDone: () => void      // payment received and shown: open the receipt
  onCash: () => void      // QR closed: back to the bill to take cash
  onBack: () => void      // back to the bill; the QR stays open and shows again on return
}) {
  const order = t.onlineCheckout
  const fromTicket: Code | null = order?.upiQr || order?.qrImage ? { text: order.upiQr, image: order.qrImage } : null
  // An older order on this ticket (payment link or Checkout order, no UPI QR) is replaced by a fresh UPI QR.
  const staleOrder = Boolean(order && !order.upiQr && !order.qrImage)
  const amountRef = useRef(amount)
  amountRef.current = amount
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
    catch (error) { const m = error instanceof Error ? error.message : 'Something went wrong. Check the payment status.'; lastError.current = m; setMessage(m); return undefined }
    finally { busyRef.current = false; setBusy(false) }
  }

  const create = async (): Promise<unknown> => { const r = await createOnce(); if (r === undefined && /amount changed/i.test(lastError.current)) { await new Promise(x => setTimeout(x, 800)); return createOnce() } return r }
  const lastError = useRef('')
  const createOnce = () => run(async () => {
    const o = await callParkingPayment<Order>('create-order', { ticket_id: t.id, amount: amountRef.current, currency: 'INR', receipt: t.id, upi_qr: true })
    if (!o.upi_qr && !o.qr_image) {
      // Razorpay gave a payment link (its page asks for a mobile number), not a UPI QR: close it and say why.
      if (o.link_url) await callParkingPayment('switch-to-cash', { ticket_id: t.id }).catch(() => undefined)
      throw new Error(NO_QR)
    }
    setCode({ text: o.upi_qr, image: o.qr_image })
    setMadeAt(Date.now())
    return true
  })

  // Open the pay screen: reuse the open QR, or make one for the exact amount.
  useEffect(() => {
    if (started.current) return
    started.current = true
    // An old Razorpay payment link is open (its page asks for a mobile number): close it quietly and make a UPI QR instead.
    if (staleOrder) void (async () => { const closed = await run(async () => { const r = await callParkingPayment<{ revision: number }>('switch-to-cash', { ticket_id: t.id }); onRevision(r.revision); return true }); if (closed) { await new Promise(r => setTimeout(r, 600)); await create() } })()
    else if (!order) void create()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Check with Razorpay every 1.5 s, so the screen turns Paid even without a tap.
  useEffect(() => {
    if (!code || paid) return
    let live = true
    const i = setInterval(async () => {
      if (busyRef.current) return
      try { const r = await callParkingPayment<PaymentStatus>('check-payment', { ticket_id: t.id }); if (live) onRevision(r.revision) } catch { /* not paid yet */ }
    }, 1500)
    return () => { live = false; clearInterval(i) }
  }, [code, paid, t.id, onRevision])

  // Money received: chime, show it for a moment, then open the receipt.
  useEffect(() => {
    if (!paid) return
    chime()
    const i = setTimeout(onDone, 1100)
    return () => clearTimeout(i)
  }, [paid]) // eslint-disable-line react-hooks/exhaustive-deps

  const check = () => run(async () => { const r = await callParkingPayment<PaymentStatus>('check-payment', { ticket_id: t.id }); onRevision(r.revision) })
  const close = () => run(async () => { const r = await callParkingPayment<{ revision: number }>('switch-to-cash', { ticket_id: t.id }); onRevision(r.revision); return true })
  const cancelQr = async () => { if (!code) { onCash(); return } if (await close()) onCash() }
  const remake = async () => { if (await close()) { setCode(null); await create() } }

  // Only a plain QR goes in the box. An older QR that came as Razorpay's full picture is replaced once by a plain one.
  const pictureOnly = Boolean(code?.image && !code.text)
  const remade = useRef(false)
  useEffect(() => {
    if (!pictureOnly || paid || remade.current || busyRef.current) return
    remade.current = true
    void remake()
  }, [pictureOnly, paid]) // eslint-disable-line react-hooks/exhaustive-deps

  const mm = String(Math.floor(left / 60000)).padStart(2, '0'), ss = String(Math.floor(left / 1000) % 60).padStart(2, '0')
  const state = paid ? 'paid' : expired ? 'expired' : code?.text ? 'waiting' : 'making'

  return (
    <section className={'q9 q9-' + state} aria-label="Pay by UPI">
      {!paid && <div className="q9-top">
        <button className="btn btn-ghost" disabled={busy} onClick={onBack}><Ico n="back" size={18} /> Back to bill</button>
        <button className="btn btn-ghost danger-text" disabled={busy} onClick={() => setConfirmCash(true)}><Ico n="x" size={16} /> Cancel QR</button>
      </div>}
      {/* Design 7: a short bill above the QR, so the customer sees why they pay this amount */}
      <div className="q9-bill">
        <div className="q9-bh"><span className="hsrp"><i />{prettyPlate(t.plate)}</span><small>{vehicle} · {dur(now - t.entryAt)}</small></div>
        {lines.filter(l => l.paise !== 0 || lines.length === 1).map((l, i) => <div key={i} className="q9-bl"><span>{l.label}</span><b className="num">{l.paise < 0 ? '− ' + rupees(-l.paise) : rupees(l.paise)}</b></div>)}
        <div className="q9-bl q9-bt"><span>Total</span><b className="num">{rupees(amount)}</b></div>
      </div>

      <div className="q9-card">
        <div className="q9-code">
          {code?.text ? <QR text={code.text} size={480} level="M" /> : <div className="q9-ph" />}
          {state === 'paid' && <div className="q9-over ok"><span className="q9-tick"><Ico n="check" size={40} /></span><b>{rupees(amount)} received</b><small>Opening the receipt…</small></div>}
          {state === 'expired' && <div className="q9-over"><b>QR expired</b><small>It was valid for 30 minutes. Make a new one for the amount due now.</small>
            <button className="btn btn-primary" disabled={busy} onClick={() => void remake()}><Ico n="qr" /> Make new QR</button></div>}
          {state === 'making' && <div className="q9-over"><small>{busy ? 'Making the QR…' : 'The QR could not be made.'}</small>
            {!busy && <button className="btn btn-primary" onClick={() => void (code ? remake() : create())}>Try again</button>}
            {!busy && code?.image && <a className="link" href={code.image} target="_blank" rel="noopener noreferrer">Open on Razorpay instead</a>}</div>}
          {confirmCash && !paid && <div className="q9-over">
            <b>Cancel this QR?</b><small>The customer can't pay it after this. If they say money was debited, tap Check first.</small>
            <div className="q9-confirm">
              <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmCash(false)}>Keep QR</button>
              <button className="btn btn-danger" disabled={busy} onClick={() => void cancelQr()}>{busy ? 'Closing…' : 'Cancel QR'}</button>
            </div>
            <button className="link" disabled={busy} onClick={() => void check()}>Check payment</button>
          </div>}
        </div>
        <p className="q9-note">Scan with any UPI app{code?.text ? <> · valid <b className="num">{mm}:{ss}</b></> : ''}</p>
      </div>

      <p className={'q9-status ' + state} role="status">
        {state === 'paid' ? 'Payment received' : state === 'expired' ? 'QR expired' : state === 'making' ? 'Getting the QR ready' : <><span className="q9-dots"><i /><i /><i /></span>Waiting for payment</>}
      </p>

      <div className="q9-actions">
        {state === 'expired' && <button className="btn btn-xl q9-dark" disabled={busy} onClick={() => void remake()}><Ico n="qr" /> Make new QR · {rupees(amount)}</button>}
        {!paid && !confirmCash && <button className="btn btn-ghost btn-lg" disabled={busy} onClick={() => setConfirmCash(true)}><Ico n="cash" /> Switch to cash</button>}
        {message && <p className="msg bad" role="alert">{message}</p>}
        {!paid && <p className="q9-foot">Checked automatically every 1.5 s · <button className="link" disabled={busy} onClick={() => void check()}>Check now</button></p>}
      </div>
    </section>
  )
}
