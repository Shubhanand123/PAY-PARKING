import { RazorpayCheckout } from './RazorpayCheckout'
import { PosPay } from './PosPay'
import { setBusy as markBusy } from './updater'
import { PlateScanner } from './PlateScanner'
import { warmPlateReader } from './plate-worker'
import { differsByOneConfusableCharacter, ticketTokenFromQr } from './plate-reading'
import { createWedgeReader } from './scanner-wedge'
import { nativeApp } from './native'
import { cancelTicket, createEntry, logLookup, markPrinted, recordExit, takeCash } from './actions'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  activeTariff, billFor, charge, checkPlate, findActiveByPlate, findTicketBySlip, fmtDT, fmtTime, dur,
  isSupportedPlateFormat, normPlate, prepaidPrice, fmtDate, prettyPlate, rupees, freeVehicleFor, type DB, type Receipt, type Staff, type Ticket,
} from './engine'
import { printSlip } from './print'
import { Ico, Pill, QR, ticketUrl, useNow } from './ui'
import { saveStart, saveEnd, saveFloat } from './done'
import { cashCelebrate } from './celebrate'
import { alreadyInside, ticketCancelled } from './fx'

// ---------- 58 mm parking slip ----------
/** The exit receipt exactly as it was saved when the bill was paid. */
function ReceiptCopy({ db, r, t }: { db: DB; r: Receipt; t: Ticket }) {
  const tv = db.tariffs.find(x => x.id === t.tariffId)
  const rt = tv?.rates[t.category]
  const rates = tv && rt ? { v: tv.version, text: `${rupees(rt.firstPaise)} first ${rt.firstHours}h, ${rupees(rt.perHourPaise)} per started hour, ${tv.graceMin} min free${rt.capPaise ? `, max ${rupees(rt.capPaise)} / 24h` : ''}` } : null
  return (
    <div className="slip" aria-label="Receipt">
      <div className="slip-sim">58 mm</div>
      <b className="slip-h">{r.operator}</b>
      <div>{r.siteName}</div>
      <div className="slip-s">{r.address} · {r.phone}</div>
      {r.gstin && <div className="slip-s">GSTIN: {r.gstin}</div>}
      <hr />
      <div className="slip-big">{r.free ? 'RECEIPT · FREE' : 'RECEIPT'}</div>
      <div className="slip-row"><span>Receipt</span><b>{r.receiptNo}</b></div>
      <div className="slip-row"><span>Ticket</span><b>{r.ticketId}</b></div>
      <div className="slip-plate"><i>IND</i>{prettyPlate(r.plate)}</div>
      <div className="slip-row"><span>Vehicle</span><b>{r.vehicle}</b></div>
      <div className="slip-row"><span>Entry</span><b>{fmtDT(r.entryAt)}</b></div>
      <div className="slip-row"><span>Billed</span><b>{fmtDT(r.billedAt)}</b></div>
      <div className="slip-row"><span>Stay</span><b>{dur(r.minutes * 60000)}</b></div>
      <hr />
      {r.lines.map((l, i) => <div key={i} className="slip-row"><span>{l.label}</span><b>{l.paise < 0 ? '− ' + rupees(-l.paise) : rupees(l.paise)}</b></div>)}
      <div className="slip-row slip-tot"><span>TOTAL</span><b>{rupees(r.totalPaise)}</b></div>
      {r.payments.map((p, i) => <div key={i} className="slip-row"><span>{p.kind === 'prepaid' ? 'Paid at entry' : p.method === 'razorpay' ? 'Paid by UPI (Razorpay)' : 'Cash paid'}</span><b>{rupees(p.amountPaise)}</b></div>)}
      {r.free && <div className="slip-free">Free vehicle · {r.free.reason}<br />{rupees(r.free.waivedPaise)} waived</div>}
      <div className="slip-qr-row"><QR text={ticketUrl(t.token)} size={96} /><span>{rates ? `Rates v${rates.v}: ${rates.text}. ` : ''}Thank you · Issued by {r.issuedBy}</span></div>
    </div>
  )
}

export function Slip({ db, t, receipt }: { db: DB; t: Ticket; receipt?: boolean }) {
  if (receipt && t.receipt) return <ReceiptCopy db={db} r={t.receipt} t={t} />
  const tv = db.tariffs.find(x => x.id === t.tariffId)!
  const r = tv.rates[t.category]
  const cat = db.categories.find(c => c.id === t.category)
  const pays = db.payments.filter(p => p.ticketId === t.id)
  const b = receipt ? billFor(db, t, t.billedAt ?? Date.now()) : null
  return (
    <div className="slip" aria-label={receipt ? 'Receipt preview' : 'Entry slip preview'}>
      <div className="slip-sim">58 mm</div>
      <b className="slip-h">{db.settings.operator}</b>
      <div>{db.settings.siteName}</div>
      <div className="slip-s">{db.settings.address} · {db.settings.phone}</div>
      {db.settings.gstin && <div className="slip-s">GSTIN: {db.settings.gstin}</div>}
      <hr />
      <div className="slip-big">{receipt ? 'RECEIPT' : 'PARKING SLIP'}</div>
      <div className="slip-row"><span>Ticket</span><b>{t.id}</b></div>
      {receipt && pays.length > 0 && <div className="slip-row"><span>Receipt</span><b>{pays[pays.length - 1].receiptNo}</b></div>}
      <div className="slip-plate"><i>IND</i>{prettyPlate(t.plate)}</div>
      <div className="slip-row"><span>Vehicle</span><b>{cat?.name}</b></div>
      <div className="slip-row"><span>Entry</span><b>{fmtDT(t.entryAt)}</b></div>
      <div className="slip-row"><span>Gate</span><b>{t.entryGate}</b></div>
      {receipt && t.exitAt && <div className="slip-row"><span>Exit</span><b>{fmtDT(t.exitAt)}</b></div>}
      {receipt && b && <>
        <div className="slip-row"><span>Stay</span><b>{dur(b.minutes * 60000)}</b></div>
        <hr />
        {b.lines.map((l, i) => <div key={i} className="slip-row"><span>{l.label}</span><b>{rupees(l.paise)}</b></div>)}
        <div className="slip-row slip-tot"><span>TOTAL</span><b>{rupees(t.totalPaise ?? b.totalPaise)}</b></div>
        {pays.map(payment => <div key={payment.id} className="slip-row"><span>{payment.method === 'razorpay' ? 'Razorpay' : 'Cash paid'}</span><b>{rupees(payment.amountPaise)}</b></div>)}
      </>}
      {!receipt && <>
        {t.prepaidHours > 0 && <div className="slip-row"><span>Prepaid</span><b>{t.prepaidHours}h · {rupees(pays[0]?.amountPaise ?? 0)}</b></div>}
        <hr />
        <div className="slip-rules">
          <b>Rates (v{tv.version}, fixed for this ticket)</b><br />
          First {r.firstHours}h {rupees(r.firstPaise)} · then {rupees(r.perHourPaise)} per started hour ·
          Free if you leave within {tv.graceMin} min{r.capPaise ? ` · Max ${rupees(r.capPaise)} per 24h` : ''}.
          {t.prepaidHours > 0 && ' Prepaid time is not refunded; extra time is charged at exit.'}
          {' '}Final amount is worked out at exit.
        </div>
      </>}
      <div className="slip-qr-row"><QR text={ticketUrl(t.token)} size={96} /><span>Scan to see your ticket, time and amount. Keep this slip for the exit.</span></div>
    </div>
  )
}

// ---------- entry ----------
export function Entry({ db, me, toast, onFlow }: { db: DB; me: Staff; toast: (m: string, bad?: boolean) => void; onFlow?: (flow: string) => void }) {
  useEffect(() => { if (!nativeApp) void warmPlateReader().catch(() => {}) }, [])
  const [plate, setPlate] = useState('')
  const [conf, setConf] = useState<number | null>(null)
  const [cat, setCat] = useState('')
  const [hours, setHours] = useState(1)
  const [paymentTiming, setPaymentTiming] = useState<'before' | 'exit'>('exit')
  const [done, setDone] = useState<{ t: Ticket; dup: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [printFail, setPrintFail] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [alternatives, setAlternatives] = useState<string[]>([])
  const inp = useRef<HTMLInputElement>(null)
  const chk = plate ? checkPlate(plate) : null
  const validPlate = isSupportedPlateFormat(plate)
  const already = plate.length >= 4 ? findActiveByPlate(db, plate) : undefined
  const tv = activeTariff(db)
  const prepaid = db.settings.payAtEntry && paymentTiming === 'before' && !already
  const rate = tv.rates[cat]
  const advance = prepaid && rate ? prepaidPrice(hours, rate) : 0
  useLayoutEffect(() => { onFlow?.(done ? 'Parking slip' : '') }, [done, onFlow])
  // Updates wait while anything is typed, chosen, open or being scanned.
  useEffect(() => { markBusy('entry', Boolean(plate || cat || done || scanning || busy)); return () => markBusy('entry', false) }, [plate, cat, done, scanning, busy])
  useLayoutEffect(() => () => onFlow?.(''), [onFlow])

  const confirm = async () => {
    if (busy) return // one tap only
    setBusy(true)
    try {
      const note = conf !== null && conf < 0.8 ? 'low-confidence scan, operator confirmed' : undefined
      const r = await createEntry(me.id, plate, cat || already?.category || '', prepaid ? hours : 0, note, advance)
      setDone({ t: r.ticket, dup: r.duplicate })
      try { navigator.vibrate?.(r.duplicate ? [40, 60, 40] : 35) } catch { /* no vibration */ }
      if (r.duplicate) alreadyInside(prettyPlate(r.ticket.plate), `Came in at ${fmtTime(r.ticket.entryAt)} · Ticket ${r.ticket.id}`)
      else void printSlip().then(() => print(r.ticket)) // the slip prints by itself; Reprint stays on screen
    } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }
  const print = async (t: Ticket) => {
    try {
      await markPrinted(me.id, t.id, 'slip')
      setPrintFail(false)
    } catch (error) {
      setPrintFail(true)
      toast((error as Error).message, true)
    }
  }
  const next = () => { setDone(null); setPlate(''); setConf(null); setAlternatives([]); setCat(''); setHours(1); setPaymentTiming('exit'); setPrintFail(false); window.scrollTo({ top: 0, behavior: 'smooth' }) } // no keyboard: the next vehicle starts with Scan plate

  if (done) {
    const t = db.tickets.find(x => x.id === done.t.id) ?? done.t
    return (
      <div className="stack paper-screen">
        {done.dup && <div className="banner banner-warn"><Ico n="warn" /> <div><b>Already inside.</b> {prettyPlate(t.plate)} came in at {fmtTime(t.entryAt)}. No new ticket was made. You can reprint this one.</div></div>}
        {printFail && <p className="msg bad" role="alert">The print was not logged. Tap Reprint to try again.</p>}
        <div className="paper-full"><Slip db={db} t={t} /></div>
        <div className="actionbar duo">
          <button className="btn btn-ghost btn-xl" onClick={() => void printSlip().then(() => print(t))}><Ico n="print" size={22} /> {done.dup && t.prints === 0 ? 'Print' : 'Reprint'}</button>
          <button className="btn btn-primary btn-xl" onClick={e => saveThen(e.currentTarget, next)}><Ico n="check" size={22} /> Next vehicle</button>
        </div>
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="card">
        <button className="btn btn-primary btn-xl" onClick={() => setScanning(true)}><Ico n="scan" size={26} /> Scan plate</button>
        {scanning && <PlateScanner onClose={() => setScanning(false)} onRead={result => {
          setScanning(false)
          setPlate(result.plate)
          setConf(result.confidence)
          setAlternatives(result.alternatives)
        }} />}
        <label className="lbl" htmlFor="plate">Vehicle number</label>
        <input id="plate" ref={inp} className="field plate-field" value={plate} inputMode="text" enterKeyHint="done" autoCapitalize="characters" autoComplete="off"
          placeholder="MH 12 AB 1234" onChange={e => { setPlate(normPlate(e.target.value)); setConf(null); setAlternatives([]) }} />
        {chk && <div className="plate-meta">
          {validPlate ? <Pill tone="ok">{chk.kind === 'bharat' ? 'Bharat series' : chk.kind === 'temporary' ? 'Temporary' : 'Valid format'} · {chk.pretty}</Pill> : <Pill tone="warn">Check the plate format, e.g. GA 01 AB 1234</Pill>}
          {conf !== null && <Pill tone="warn">Check the scanned plate</Pill>}
          {validPlate && freeVehicleFor(db, plate) && <Pill tone="ok">Free vehicle · {freeVehicleFor(db, plate)!.reason}</Pill>}
        </div>}
        {chk?.suggestion && isSupportedPlateFormat(chk.suggestion) && <button className="btn btn-ghost sug" onClick={() => { setPlate(chk.suggestion!); setConf(null) }}>Use {prettyPlate(chk.suggestion)}</button>}
        {conf !== null && /[VY]/.test(plate) && <p className="tiny muted">Check V and Y against the plate.</p>}
        {alternatives.length > 0 && <div className="chips" aria-label="Other camera readings">{alternatives.map(value =>
          <button key={value} className="chip" onClick={() => { setPlate(value); setAlternatives([]) }}>Try {prettyPlate(value)}</button>
        )}</div>}
        {already && <div className="banner banner-warn"><Ico n="warn" /><div>This vehicle is already inside (ticket {already.id}, {fmtTime(already.entryAt)}). Confirming will show that ticket instead of making a new one.</div></div>}
      </div>
      <div className="card">
        <span className="lbl">Vehicle type</span>
        <div className="cats">
          {db.categories.filter(c => c.active).map(c => (
            <button key={c.id} className={'cat' + (cat === c.id ? ' on' : '')} onClick={() => setCat(c.id)} aria-pressed={cat === c.id}>
              <span className={'cat-ico v-' + c.id}><Ico n={c.icon} size={34} /></span>
              <span className="cat-name">{c.name}</span>
              <span className="cat-rate"><b className="num">{rupees(tv.rates[c.id].firstPaise)}</b><em>/ {tv.rates[c.id].firstHours}h</em></span>
              <small className="cat-more num">then {rupees(tv.rates[c.id].perHourPaise)}/hr</small>
            </button>
          ))}
        </div>
      </div>
      {db.settings.payAtEntry && !already && (
        <fieldset className="card payment-choice">
          <legend className="lbl">When will they pay?</legend>
          <div className="row2">
            <label className="payment-option"><input type="radio" name="payment-timing" checked={paymentTiming === 'exit'} onChange={() => setPaymentTiming('exit')} /><span>Pay at exit</span></label>
            <label className="payment-option"><input type="radio" name="payment-timing" checked={paymentTiming === 'before'} onChange={() => setPaymentTiming('before')} /><span>Pay before parking</span></label>
          </div>
          {prepaid && <div className="stack">
            <div>
              <span className="lbl">Prepaid hours</span>
              <div className="chips">{[1, 2, 3, 4, 6, 8, 12, 24].map(h => <button key={h} className={'chip' + (hours === h ? ' on' : '')} aria-pressed={hours === h} onClick={() => setHours(h)}>{h}h</button>)}</div>
            </div>
            {rate ? <div className="due"><span>Cash to collect</span><b>{rupees(advance)}</b></div> : <p className="muted small">Select a vehicle type to see the advance amount.</p>}
            <p className="tiny muted">Any extra time is charged at exit.</p>
          </div>}
        </fieldset>
      )}
      {!already && (!validPlate || !cat) && <p className="next-hint">{!validPlate ? 'Scan the plate or type the number' : 'Now tap the vehicle type'}</p>}
      <div className="actionbar"><button className="btn btn-primary btn-xl" disabled={(!validPlate && !already) || (!cat && !already) || busy || scanning} onClick={confirm}>
        <Ico n={already ? 'search' : 'check'} size={24} />
        {busy ? 'Saving…' : already ? 'Open existing ticket' : prepaid && advance > 0 ? `Record ${rupees(advance)} cash & save` : 'Save entry'}
      </button></div>
    </div>
  )
}

// ---------- exit ----------
export function Exit({ db, me, toast, onFlow }: { db: DB; me: Staff; toast: (m: string, bad?: boolean) => void; onFlow?: (flow: string) => void }) {
  useEffect(() => {
    if (!nativeApp) void warmPlateReader().catch(() => {})
    void import('jsqr').catch(() => {})
  }, [])
  const [q, setQ] = useState('')
  const [scanningPlate, setScanningPlate] = useState(false)
  const [scannedPlate, setScannedPlate] = useState(false)
  const [plateAlternatives, setPlateAlternatives] = useState<string[]>([])
  const [id, setId] = useState<string | null>(null)
  const [pick, setPick] = useState<Ticket[] | null>(null)
  const [confirmLost, setConfirmLost] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [reason, setReason] = useState('')
  const [rev, setRev] = useState(0)
  const [busy, setBusy] = useState(false)
  const [paying, setPaying] = useState(false)
  const [menu, setMenu] = useState(false)
  const now = useNow(10000)
  const t = id ? db.tickets.find(x => x.id === id) : undefined
  // An open UPI QR on this ticket: go straight to the pay screen.
  useEffect(() => { if (t?.onlineCheckout && t.status === 'inside') setPaying(true) }, [t?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // H2 header: the Entry/Exit switch shows only on the lookup and the bill, not on the QR or the receipt.
  const flow = !t ? '' : paying ? 'Pay by UPI' : t.status === 'paid' || t.status === 'exited' ? 'Receipt' : ''
  useLayoutEffect(() => { onFlow?.(flow) }, [flow, onFlow])
  useEffect(() => { markBusy('exit', Boolean(t || q || scanningPlate || pick || busy)); return () => markBusy('exit', false) }, [t, q, scanningPlate, pick, busy])
  useLayoutEffect(() => () => onFlow?.(''), [onFlow])
  const active = db.tickets.filter(x => x.status === 'inside' || x.status === 'paid')
  const nq = normPlate(q)
  const filtered = nq.length >= 2 ? active.filter(x => x.plate.includes(nq) || x.id.replace('-', '').includes(nq)) : active

  const open = (x: Ticket, how: 'plate' | 'qr' | 'search') => { setId(x.id); setRev(x.rev); setPick(null); setConfirmLost(how !== 'qr'); void logLookup(me.id, x.id, how).catch(error => toast(error.message, true)) }
  const find = (how: 'qr' | 'plate' | 'auto', input = q) => {
    const s = input.trim()
    setPick(null)
    if (!s) return
    if (how !== 'plate') {
      const ticket = findTicketBySlip(db.tickets, s)
      if (ticket) return open(ticket, 'qr')
      if (how === 'qr' || /^T-?\d+$|#\/t\//i.test(s)) {
        return toast('No ticket with that QR or number.', true)
      }
    }
    const n = normPlate(s)
    if (n.length < 2) return toast('Enter a vehicle number or its last 4 digits.', true)
    const exact = active.find(y => y.plate === n)
    const confused = active.filter(ticket => differsByOneConfusableCharacter(n, ticket.plate) || (scannedPlate && plateAlternatives.includes(ticket.plate)))
    if (scannedPlate && exact && confused.length) { setPick([exact, ...confused]); return }
    if (exact) return open(exact, 'plate')
    const near = active.filter(y => confused.includes(y) || y.plate.includes(n) || n.includes(y.plate.slice(-4)) || y.plate.slice(-4) === n.slice(-4))
    if (!near.length) return toast('No vehicle inside matches. Try the last 4 digits.', true)
    setPick(near)
  }
  const printReceipt = async (x: Ticket) => {
    await printSlip()
    try { await markPrinted(me.id, x.id, 'receipt') } catch (error) { toast((error as Error).message, true) }
  }
  // As soon as the bill is paid (cash, free, or online) the receipt prints by itself, once per ticket.
  const autoPrinted = useRef('')
  const paidNow = t && t.status === 'paid' && !t.receiptPrints ? t : undefined
  useEffect(() => {
    if (!paidNow || autoPrinted.current === paidNow.id) return
    autoPrinted.current = paidNow.id
    void printReceipt(paidNow)
  })
  const reset = () => { setId(null); setPaying(false); setMenu(false); setQ(''); setScannedPlate(false); setPlateAlternatives([]); setPick(null); setCancelling(false); setReason('') }

  // The POS's built-in barcode scanner types the ticket QR like a keyboard and presses Enter.
  const wedge = useRef({ find, reset, toast, ticket: t })
  useEffect(() => { wedge.current = { find, reset, toast, ticket: t } })
  useEffect(() => {
    const read = createWedgeReader(value => {
      const { find, reset, toast, ticket } = wedge.current
      if (ticket && ticket.status !== 'exited' && ticket.status !== 'cancelled') {
        toast('Finish this ticket, then tap New lookup before scanning the next one.', true)
        return
      }
      reset()
      setScanningPlate(false)
      find('auto', value)
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
      if (read(event.key, event.timeStamp)) { event.preventDefault(); event.stopPropagation() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (t) {
    const b = billFor(db, t, now)
    const cat = db.categories.find(c => c.id === t.category)
    const tv = db.tariffs.find(x => x.id === t.tariffId)!
    const rate = tv.rates[t.category]
    const stale = t.rev !== rev && !(t.onlineCheckout && t.status === 'paid')
    const act = async (label: string, fn: () => Promise<void>) => {
      if (busy) return
      setBusy(true)
      if (label) { saveFloat(); saveStart() }
      try { await fn(); if (label) saveEnd(true, label) }
      catch (error) { if (label) saveEnd(false, ''); toast((error as Error).message, true) }
      finally { setBusy(false) }
    }
    const staleBanner = stale && t.status !== 'cancelled' && <div className="banner banner-warn"><Ico n="warn" /><div>This ticket was changed on another device. <button className="link" onClick={() => setRev(t.rev)}>Reload</button></div></div>
    const cancelCard = cancelling && <div className="card">
      <label className="lbl" htmlFor="rsn">Reason {db.settings.cancelNeedsReason ? '(required)' : '(optional)'}</label>
      <input id="rsn" className="field small-field" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. wrong vehicle type" />
      <div className="row2"><button className="btn btn-ghost" onClick={() => setCancelling(false)}>Keep</button><button className="btn btn-danger" onClick={() => act('', async () => { await cancelTicket(me.id, t.id, reason); setCancelling(false); ticketCancelled(prettyPlate(t.plate), t.id, fmtTime(Date.now())) })}>Cancel ticket</button></div>
    </div>

    // Q9: pay by UPI QR. Stays on screen until the "received" moment has played, then the receipt opens.
    if (paying && (t.status === 'inside' || t.status === 'paid')) return (
      <PosPay t={t} amount={t.status === 'inside' ? b.duePaise : (t.totalPaise ?? b.totalPaise) - b.prepaidPaise} vehicle={cat?.name ?? ''} paid={t.status === 'paid'}
        onRevision={setRev} onDone={() => setPaying(false)} onCash={() => setPaying(false)} onBack={() => setPaying(false)} />
    )

    // Receipt: full screen, green light from the bottom while the vehicle is paid but still here.
    if (t.status === 'paid' || t.status === 'exited') return (
      <div className={'stack paper-screen' + (t.status === 'paid' ? ' lit' : '')}>
        {t.status === 'paid' && <><span className="paid-glow" aria-hidden="true" /><span className="paid-flash" aria-hidden="true" /></>}
        {t.status === 'exited' && <div className="banner banner-ok"><Ico n="check" /><div><b>Closed.</b> Left at {fmtTime(t.exitAt!)} by {t.exitGate}.</div></div>}
        <div className="paper-full"><Slip db={db} t={t} receipt /></div>
        {staleBanner}
        {cancelCard}
        <div className="actionbar duo">
          <button className="btn btn-ghost btn-xl" onClick={() => void printReceipt(t)}><Ico n="print" size={22} /> Reprint</button>
          {t.status === 'paid'
            ? <button className="btn btn-primary btn-xl" disabled={stale || busy} onClick={() => act('', async () => { const r = await recordExit(me.id, t.id); setRev(r.rev) })}><Ico n="out" size={22} /> Vehicle left</button>
            : <button className="btn btn-primary btn-xl" onClick={e => saveThen(e.currentTarget, reset)}><Ico n="check" size={22} /> Next vehicle</button>}
        </div>
        {t.status === 'paid' && !t.onlineCheckout && !cancelling && <button className="link danger" onClick={() => setCancelling(true)}>Cancel this ticket</button>}
      </div>
    )

    if (t.status === 'cancelled') return (
      <div className="stack">
        <div className="banner banner-bad"><Ico n="x" /><div><b>Cancelled</b> by {t.cancelledBy} at {fmtTime(t.cancelledAt!)}{t.cancelReason ? `: ${t.cancelReason}` : ''}.</div></div>
        <button className="btn btn-primary" onClick={reset}><Ico n="back" /> New lookup</button>
      </div>
    )

    // Exit bill: everything on one screen.
    const why = (label: string) =>
      label.startsWith('First') ? `${cat?.name} · rates v${tv.version}, fixed at entry`
        : label.includes('extra hour') ? `Every started hour after ${rate.firstHours}h`
          : label.includes('grace') ? `Left within ${tv.graceMin} minutes`
            : label.includes('full day') ? (rate.capPaise ? 'Each full day is charged at the 24-hour maximum' : 'Each full 24 hours at the normal rates')
              : label.startsWith('Daily cap') ? `Never more than ${rupees(rate.capPaise)} per 24 hours`
                : label.startsWith('Free vehicle') ? 'On the owner\'s free list'
                  : label === 'Paid at entry' ? 'Paid when the vehicle came in'
                    : label.startsWith('Minimum') ? 'The prepaid block is the minimum charge' : ''
    const upi = db.razorpayEnabled && b.duePaise >= 100 && navigator.onLine
    return (
      <div className="stack exit-bill">
        <div className="card tk2">
          <div className="tk2-head">
            <button className="icon-btn" onClick={reset} aria-label="Back to lookup"><Ico n="back" /></button>
            <span className="ind-plate"><i />{prettyPlate(t.plate)}</span>
            {!t.onlineCheckout && <button className="icon-btn more" aria-label="More options" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>}
          </div>
          <div className="tk2-sub"><span className="veh-chip"><Ico n={cat?.icon ?? 'car'} size={20} />{cat?.name}</span><span className="muted small">{t.id}</span><StatusPill t={t} />{confirmLost && <Pill tone="warn">Found by plate</Pill>}</div>
          {menu && <div className="tk2-menu"><button className="link danger" onClick={() => { setMenu(false); setCancelling(true) }}><Ico n="x" size={16} /> Cancel this ticket</button></div>}
          <SlabBar from={t.entryAt} to={now} firstHours={rate.firstHours} firstPaise={rate.firstPaise} perHourPaise={rate.perHourPaise} />
        </div>
        <div className="card bill2">
          {b.lines.map((l, i) => <div key={i} className={'bl' + (l.paise < 0 ? ' minus' : '')}>
            <div><span>{l.label}</span>{why(l.label) && <small>{why(l.label)}</small>}</div>
            <b className="num">{l.paise < 0 ? '− ' + rupees(-l.paise) : rupees(l.paise)}</b>
          </div>)}
          <div className="rule-chips">
            <span>{tv.graceMin} min free</span>{rate.capPaise > 0 && <span>Max {rupees(rate.capPaise)} / 24h</span>}<span>After {rate.firstHours}h: {rupees(rate.perHourPaise)} / hour</span>
            <span>{t.onlineCheckout ? 'Amount locked for the UPI QR' : 'Checked again before payment'}</span>
          </div>
        </div>
        <div className={'due-navy' + (b.duePaise ? '' : ' zero')}>
          <div><b>{b.duePaise ? 'To collect' : b.free ? `Free · ${b.free.reason}` : 'Nothing due'}</b><small>Gate: Exit · as of {fmtTime(now)}</small></div>
          <b className="num">{rupees(b.duePaise)}</b>
        </div>
        {staleBanner}
        {cancelCard}
        {!navigator.onLine && b.duePaise > 0 && <p className="offline-note">No internet: UPI is off. Take cash; it is saved on this POS and sent when the internet is back.</p>}
        {!stale && (b.duePaise
          ? <div className="actionbar duo">
            {upi && <button className="btn btn-xl pay-btn upi" disabled={busy} onClick={() => setPaying(true)}><Ico n="qr" size={24} /><span><b>{t.onlineCheckout ? 'Show QR' : 'UPI'}</b><small>{t.onlineCheckout ? 'QR still open' : 'Razorpay QR'}</small></span></button>}
            <button className="btn btn-xl pay-btn cash" disabled={busy || Boolean(t.onlineCheckout)} onClick={() => act('', async () => { const r = await takeCash(me.id, t.id, rev, b.duePaise); setRev(r.rev); cashCelebrate(b.duePaise, prettyPlate(t.plate)) })}>
              <Ico n="cash" size={24} /><span><b>Cash</b><small>received {rupees(b.duePaise)}</small></span></button>
          </div>
          : <div className="actionbar"><button className="btn btn-xl btn-success" disabled={busy} onClick={() => act('Done', async () => { const r = await takeCash(me.id, t.id, rev, 0); setRev(r.rev) })}>
            <Ico n="check" size={24} /> {b.free ? `Free vehicle (${b.free.reason}) · Continue` : 'Nothing due · Continue'}</button></div>)}
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="card">
        <button className="btn btn-primary btn-xl" onClick={() => setScanningPlate(true)}><Ico n="scan" /> Scan ticket or plate</button>
        <label className="lbl" htmlFor="q">Manual lookup</label>
        <input id="q" className="field plate-field" value={q} autoComplete="off" placeholder="Plate or ticket" onChange={e => {
          setQ(e.target.value); setPick(null); setScannedPlate(false); setPlateAlternatives([])
        }} onKeyDown={e => e.key === 'Enter' && find('auto')} />
        <button className="btn btn-ghost" onClick={() => find('auto')} disabled={!q.trim()}><Ico n="search" /> Find ticket</button>
        {scanningPlate && <PlateScanner onClose={() => setScanningPlate(false)} onQr={value => {
          const token = ticketTokenFromQr(value)
          if (!token) return false
          const ticket = findTicketBySlip(db.tickets, token)
          if (!ticket) return false
          setScanningPlate(false)
          open(ticket, 'qr')
          return true
        }} onRead={result => {
          setScanningPlate(false)
          const exact = active.find(y => y.plate === result.plate)
          const rivals = active.filter(y => y !== exact && (result.alternatives.includes(y.plate) || differsByOneConfusableCharacter(result.plate, y.plate)))
          if (exact && !rivals.length) { open(exact, 'plate'); return }
          setQ(result.plate)
          setPick(null)
          setScannedPlate(true)
          setPlateAlternatives(result.alternatives)
        }} />}
        {scannedPlate && <p className="small muted">Check the scanned registration, then tap Find ticket.{/[VY]/.test(q) && ' Check V and Y carefully.'}</p>}
      </div>
      {pick && <div className="card">
        <h2>Which vehicle?</h2><p className="muted small">Compare the number plate before opening a ticket.</p>
        {pick.map(x => <button key={x.id} className="listrow" onClick={() => open(x, 'search')}><b>{prettyPlate(x.plate)}</b><span>{db.categories.find(c => c.id === x.category)?.name} · in {fmtTime(x.entryAt)}</span></button>)}
      </div>}
      <div className="card">
        <h2>{filtered.length !== active.length ? <>Matches <span className="muted">({filtered.length} of {active.length})</span></> : <>Inside now <span className="muted">({active.length})</span></>}</h2>
        <div className="inside-list">
          {filtered.slice().reverse().slice(0, 40).map(x => (
            <button key={x.id} className="listrow vrow" onClick={() => open(x, 'search')}>
              <span className="vr-ico"><Ico n={db.categories.find(c => c.id === x.category)?.icon ?? 'car'} size={26} /></span>
              <span className="vr-main"><b>{prettyPlate(x.plate)}</b><small>in {fmtTime(x.entryAt)} · {dur(now - x.entryAt)}</small></span>
              {x.status === 'paid' ? <Pill tone="ok">Paid</Pill> : <span className="vr-fee num">{rupees(billFor(db, x, now).duePaise)}</span>}
            </button>
          ))}
          {active.length > 0 && !filtered.length && <p className="muted center">No vehicle inside matches “{q}”.</p>}
          {!active.length && <p className="muted">No vehicles inside.</p>}
        </div>
      </div>
    </div>
  )
}

export function StatusPill({ t }: { t: Ticket }) {
  return t.status === 'inside' ? <Pill tone="info">Inside</Pill> : t.status === 'paid' ? <Pill tone="warn">Paid · not left</Pill> : t.status === 'exited' ? <Pill tone="ok">Closed</Pill> : <Pill tone="bad">Cancelled</Pill>
}

// ---------- customer QR page ----------
export function Customer({ db, token }: { db: DB; token: string }) {
  const now = useNow(30000)
  const t = db.tickets.find(x => x.token === token)
  if (!t) return <div className="card center"><h2>Ticket not found</h2><p className="muted">Ask the attendant at the gate.</p></div>
  const tv = db.tariffs.find(x => x.id === t.tariffId)!
  const r = tv.rates[t.category]
  const b = billFor(db, t, now)
  return (
    <div className="stack">
      <div className="card">
        <div className="tk-head"><div><div className="muted small">{db.settings.siteName}</div><div className="plate-big">{prettyPlate(t.plate)}</div></div><StatusPill t={t} /></div>
        <dl className="kv">
          <div><dt>Ticket</dt><dd>{t.id}</dd></div>
          <div><dt>Entered</dt><dd>{fmtDT(t.entryAt)}</dd></div>
          {t.exitAt && <div><dt>Left</dt><dd>{fmtDT(t.exitAt)}</dd></div>}
          <div><dt>Time</dt><dd>{dur((t.exitAt ?? now) - t.entryAt)}</dd></div>
        </dl>
      </div>
      <div className="card">
        {t.status === 'inside' && <>
          <div className="muted small">{t.onlineCheckout ? 'Amount to pay' : 'Estimate if you leave now'}</div>
          <div className="amount">{rupees(b.duePaise)}</div>
          {db.razorpayEnabled && t.onlineCheckout
            ? <RazorpayCheckout key={t.id} ticketId={t.id} token={token} amount={b.duePaise} name={db.settings.operator} hasOrder linkUrl={t.onlineCheckout.linkUrl} upiQr={t.onlineCheckout.upiQr} qrImage={t.onlineCheckout.qrImage} />
            : <p className="tiny muted">{db.razorpayEnabled ? 'Ask the exit attendant to enable online payment when you are ready to leave.' : 'Pay the attendant at the exit gate.'}</p>}
        </>}
        {(t.status === 'paid' || t.status === 'exited') && <><div className="muted small">Paid</div><div className="amount ok">{rupees(t.totalPaise ?? 0)}</div></>}
        {t.status === 'cancelled' && <p>This ticket was cancelled.</p>}
      </div>
      <div className="card">
        <h2>Rates for this ticket</h2>
        <ul className="rules">
          <li>First {r.firstHours} hours: <b>{rupees(r.firstPaise)}</b></li>
          <li>Each started hour after that: <b>{rupees(r.perHourPaise)}</b></li>
          <li>Free if you leave within <b>{tv.graceMin} minutes</b></li>
          {r.capPaise > 0 && <li>Maximum <b>{rupees(r.capPaise)}</b> per 24 hours</li>}
          {t.prepaidHours > 0 && <li>You prepaid {t.prepaidHours}h. No refund for leaving early; extra time is charged at exit.</li>}
        </ul>
        <p className="tiny muted">Rates are fixed at the time you entered (version {tv.version}). Example: in at 10:00, out at 11:20 → {rupees(charge(80, r, tv.graceMin).total)}.</p>
      </div>
    </div>
  )
}

/** Entry time → now (or exit) as a road with the car moving along it. */
export function TimeStrip({ from, to, live }: { from: number; to: number; live: boolean }) {
  return (
    <div className="tstrip">
      <div className="ts-end"><span className="ts-l">In</span><b className="num">{fmtTime(from)}</b><span className="ts-d">{fmtDate(from)}</span></div>
      <div className="ts-mid"><span className="ts-dur num">{dur(to - from)}</span><i className={live ? 'live' : ''} /></div>
      <div className="ts-end r"><span className="ts-l">{live ? 'Now' : 'Out'}</span><b className="num">{fmtTime(to)}</b><span className="ts-d">{fmtDate(to)}</span></div>
    </div>
  )
}

/** Exit bill time bar: in → now, with the first slab and the extra hours marked. */
function SlabBar({ from, to, firstHours, firstPaise, perHourPaise }: { from: number; to: number; firstHours: number; firstPaise: number; perHourPaise: number }) {
  const minutes = Math.max(0, (to - from) / 60000)
  const extra = Math.max(0, Math.ceil(minutes / 60) - firstHours)
  const span = Math.max(minutes, firstHours * 60)
  const first = Math.min(minutes, firstHours * 60) / span
  return (
    <div className="slab">
      <div className="slab-top">
        <div><small>In · {fmtDate(from)}</small><b className="num">{fmtTime(from)}</b></div>
        <span className="slab-dur num">{dur(to - from)}</span>
        <div className="r"><small>Now</small><b className="num">{fmtTime(to)}</b></div>
      </div>
      <div className="slab-bar"><i className="a" style={{ width: first * 100 + '%' }} /><i className="b" style={{ width: (minutes / span - first) * 100 + '%' }} /></div>
      <div className="slab-foot"><span>First {firstHours}h · {rupees(firstPaise)}</span>{extra > 0 && <span>+{extra} hour{extra > 1 ? 's' : ''} · {rupees(extra * perHourPaise)}</span>}</div>
    </div>
  )
}

/** Play the Waste Ops "Saved" tick on the pressed button itself, and only move to the next screen once it has finished. */
let saving = false
function saveThen(btn: HTMLButtonElement, then: () => void) {
  if (saving) return
  saving = true
  btn.disabled = true
  saveStart()
  // the tick plays and fades out on this screen; only then does the next screen open
  saveEnd(true, 'Saved').then(() => { saving = false; then() })
}
