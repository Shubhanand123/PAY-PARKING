import { useMemo, useState, type FormEvent } from 'react'
import { addFreeVehicle, markPrinted, removeFreeVehicle } from './actions'
import { dur, fmtDT, fmtTime, freeVehicleFor, istDay, isSupportedPlateFormat, normPlate, prettyPlate, rupees, type DB, type Staff, type Ticket } from './engine'
import { Slip, StatusPill } from './Gate'
import { printSlip } from './print'
import { Ico, Pill } from './ui'
import { callParking } from './parking-api'

type Toast = (message: string, bad?: boolean) => void
const DAY = 24 * 3600_000

/** The slip (vehicle inside) or the saved receipt (paid or left), with a logged Reprint button. */
export function TicketPaper({ db, t, me, toast }: { db: DB; t: Ticket; me: Staff; toast: Toast }) {
  const receipt = t.status === 'paid' || t.status === 'exited'
  const reprint = async () => {
    await printSlip()
    try { await markPrinted(me.id, t.id, receipt ? 'receipt' : 'slip'); toast(receipt ? 'Receipt reprinted' : 'Slip reprinted') }
    catch (error) { toast((error as Error).message, true) }
  }
  const count = receipt ? t.receiptPrints ?? 0 : t.prints
  return (
    <div className="stack paper">
      <Slip db={db} t={t} receipt={receipt} />
      <button className="btn btn-ghost" onClick={() => void reprint()} disabled={t.status === 'cancelled'}>
        <Ico n="print" /> Reprint {receipt ? 'receipt' : 'slip'}
      </button>
      <p className="tiny muted center">{receipt ? 'Receipt' : 'Slip'} printed {count} {count === 1 ? 'time' : 'times'}. Every reprint is in the master audit.</p>
    </div>
  )
}

const paidFor = (db: DB, t: Ticket) => db.payments.filter(p => p.ticketId === t.id).reduce((sum, p) => sum + p.amountPaise, 0)

// ---------- customers (by vehicle number) ----------
export function Customers({ db, me, toast }: { db: DB; me: Staff; toast: Toast }) {
  const [q, setQ] = useState('')
  const [plate, setPlate] = useState<string>()
  const [ticketId, setTicketId] = useState<string>()
  const people = useMemo(() => {
    const byPlate = new Map<string, Ticket[]>()
    for (const t of db.tickets) (byPlate.get(t.plate) ?? byPlate.set(t.plate, []).get(t.plate)!).push(t)
    return [...byPlate.entries()].map(([p, list]) => ({
      plate: p,
      tickets: list.slice().sort((a, b) => b.entryAt - a.entryAt),
      visits: list.filter(t => t.status !== 'cancelled').length,
      last: Math.max(...list.map(t => t.entryAt)),
      paid: list.reduce((sum, t) => sum + paidFor(db, t), 0),
      waived: list.reduce((sum, t) => sum + (t.free?.waivedPaise ?? 0), 0),
      inside: list.some(t => t.status === 'inside' || t.status === 'paid'),
    })).sort((a, b) => b.last - a.last)
  }, [db])
  const nq = normPlate(q)
  const shown = nq ? people.filter(p => p.plate.includes(nq)) : people
  const sel = plate ? people.find(p => p.plate === plate) : undefined
  const ticket = ticketId ? db.tickets.find(t => t.id === ticketId) : undefined
  const free = sel ? freeVehicleFor(db, sel.plate) : undefined

  return (
    <div className="stack">
      <div className="card toolbar">
        <input className="field small-field" placeholder="Search vehicle number" value={q} onChange={e => setQ(e.target.value)} aria-label="Search vehicle number" />
        <span className="muted small">{people.length} vehicles · {db.tickets.filter(t => t.status !== 'cancelled').length} visits</span>
      </div>
      <div className="grid2 customers">
        <div className="card table-card">
          <table className="tbl">
            <thead><tr><th>Vehicle</th><th className="r">Visits</th><th>Last visit</th><th className="r">Paid</th><th></th></tr></thead>
            <tbody>{shown.slice(0, 300).map(p => (
              <tr key={p.plate} onClick={() => { setPlate(p.plate); setTicketId(p.tickets[0]?.id) }} className={plate === p.plate ? 'sel' : ''}>
                <td><b>{prettyPlate(p.plate)}</b></td><td className="r num">{p.visits}</td><td>{fmtDT(p.last)}</td><td className="r num">{rupees(p.paid)}</td>
                <td>{freeVehicleFor(db, p.plate) ? <Pill tone="ok">Free</Pill> : p.inside ? <Pill tone="info">Inside</Pill> : null}</td>
              </tr>))}</tbody>
          </table>
          {!shown.length && <p className="muted center">No vehicle matches.</p>}
        </div>
        {sel ? <div className="stack">
          <div className="card cust-head">
            <div className="plate-big">{prettyPlate(sel.plate)}</div>
            <div className="chips-row">
              {free && <Pill tone="ok">Free vehicle · {free.reason}</Pill>}
              {sel.inside && <Pill tone="info">Inside now</Pill>}
            </div>
            <div className="cust-stats">
              <div><span>Visits</span><b className="num">{sel.visits}</b></div>
              <div><span>Total paid</span><b className="num">{rupees(sel.paid)}</b></div>
              <div><span>Free value</span><b className="num">{rupees(sel.waived)}</b></div>
            </div>
            <div className="visit-list">{sel.tickets.map(t => (
              <button key={t.id} className={'listrow' + (ticketId === t.id ? ' on' : '')} onClick={() => setTicketId(t.id)}>
                <b>{t.id}</b><span>{fmtDT(t.entryAt)}{t.exitAt ? ` · ${dur(t.exitAt - t.entryAt)}` : ''}</span>
                <span className="num">{t.free ? 'Free' : t.totalPaise != null ? rupees(t.totalPaise) : '–'}</span><StatusPill t={t} />
              </button>))}</div>
          </div>
          {ticket && <TicketPaper db={db} t={ticket} me={me} toast={toast} />}
        </div> : <div className="card"><p className="muted">Tap a vehicle to see every visit, what they paid, and the exact receipt they were given.</p></div>}
      </div>
    </div>
  )
}

// ---------- free vehicles ----------
const REASONS = ['Staff', 'Owner / family', 'Police', 'Ambulance', 'Government', 'Other']

export function FreeVehicles({ db, me, toast }: { db: DB; me: Staff; toast: Toast }) {
  const [plate, setPlate] = useState('')
  const [reason, setReason] = useState(REASONS[0])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [days, setDays] = useState(1)
  const [ticketId, setTicketId] = useState<string>()
  const list = db.freeVehicles ?? []
  const active = list.filter(v => v.active)
  const removed = list.filter(v => !v.active).sort((a, b) => (b.removedAt ?? 0) - (a.removedAt ?? 0))
  const since = days === 1 ? new Date(istDay(Date.now()) + 'T00:00:00+05:30').getTime() : Date.now() - days * DAY
  const exits = db.tickets.filter(t => t.free && (t.billedAt ?? 0) >= since).sort((a, b) => (b.billedAt ?? 0) - (a.billedAt ?? 0))
  const waived = exits.reduce((sum, t) => sum + (t.free?.waivedPaise ?? 0), 0)
  const ticket = ticketId ? db.tickets.find(t => t.id === ticketId) : undefined
  const valid = isSupportedPlateFormat(plate)

  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !valid) return
    setBusy(true)
    try { await addFreeVehicle(me.id, plate, reason, note || null); toast(`${prettyPlate(normPlate(plate))} now parks free`); setPlate(''); setNote('') }
    catch (error) { toast((error as Error).message, true) } finally { setBusy(false) }
  }
  const remove = async (p: string) => {
    try { await removeFreeVehicle(me.id, p); toast(`${prettyPlate(p)} removed from the free list`) }
    catch (error) { toast((error as Error).message, true) }
  }

  return (
    <div className="stack">
      <div className="kpis">
        <div className="kpi kpi-info"><span className="kpi-ico"><Ico n="check" /></span><div className="kpi-l">Free vehicles</div><div className="kpi-v num">{active.length}</div><div className="kpi-s">on the list now</div></div>
        <div className="kpi"><span className="kpi-ico"><Ico n="out" /></span><div className="kpi-l">Free exits</div><div className="kpi-v num">{exits.length}</div><div className="kpi-s">{days === 1 ? 'today' : `last ${days} days`}</div></div>
        <div className="kpi kpi-warn"><span className="kpi-ico"><Ico n="rupee" /></span><div className="kpi-l">Value waived</div><div className="kpi-v num">{rupees(waived)}</div><div className="kpi-s">what they would have paid</div></div>
      </div>
      <div className="grid2">
        <form className="card stack" onSubmit={add}>
          <h2>Add a free vehicle</h2>
          <label className="lbl" htmlFor="fv-plate">Vehicle number</label>
          <input id="fv-plate" className="field plate-field" value={plate} autoComplete="off" autoCapitalize="characters" placeholder="GA 01 AB 1234" onChange={e => setPlate(normPlate(e.target.value))} />
          <label className="lbl" htmlFor="fv-reason">Why it parks free</label>
          <select id="fv-reason" className="field small-field" value={reason} onChange={e => setReason(e.target.value)}>{REASONS.map(r => <option key={r}>{r}</option>)}</select>
          <label className="lbl" htmlFor="fv-note">Note (optional)</label>
          <input id="fv-note" className="field small-field" value={note} maxLength={80} placeholder="e.g. Ramesh, night guard" onChange={e => setNote(e.target.value)} />
          <button className="btn btn-primary" disabled={!valid || busy}><Ico n="check" /> Add to free list</button>
          <p className="tiny muted">At the exit these vehicles pay ₹0. The receipt still prints, marked FREE with the reason and the amount waived.</p>
        </form>
        <div className="card">
          <h2>On the free list <span className="muted">({active.length})</span></h2>
          {!active.length && <p className="muted">No free vehicles yet.</p>}
          <div className="free-list">{active.map(v => (
            <div key={v.plate} className="free-row">
              <div><b>{prettyPlate(v.plate)}</b><span className="muted small">{v.reason}{v.note ? ` · ${v.note}` : ''} · added {fmtDT(v.addedAt)}</span></div>
              <button className="btn btn-ghost fit" onClick={() => void remove(v.plate)}>Remove</button>
            </div>))}</div>
          {removed.length > 0 && <details className="removed"><summary className="small muted">Removed ({removed.length})</summary>
            {removed.map(v => <div key={v.plate + v.removedAt} className="small muted">{prettyPlate(v.plate)} · {v.reason} · removed {fmtDT(v.removedAt!)} by {v.removedBy}</div>)}
          </details>}
        </div>
      </div>
      <div className="card">
        <div className="bill-head"><h2>Free exits</h2>
          <select className="field small-field period" value={days} onChange={e => setDays(Number(e.target.value))} aria-label="Period">
            <option value={1}>Today</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option>
          </select>
        </div>
        {!exits.length ? <p className="muted">No free exits in this period.</p> :
          <div className="table-card"><table className="tbl">
            <thead><tr><th>Vehicle</th><th>Reason</th><th>In</th><th>Out</th><th>Stay</th><th className="r">Waived</th><th>Ticket</th></tr></thead>
            <tbody>{exits.map(t => (
              <tr key={t.id} onClick={() => setTicketId(t.id)} className={ticketId === t.id ? 'sel' : ''}>
                <td><b>{prettyPlate(t.plate)}</b></td><td>{t.free!.reason}</td><td>{fmtDT(t.entryAt)}</td><td>{fmtTime(t.billedAt!)}</td>
                <td>{dur((t.billedAt ?? t.entryAt) - t.entryAt)}</td><td className="r num">{rupees(t.free!.waivedPaise)}</td><td>{t.id}</td>
              </tr>))}</tbody>
          </table></div>}
      </div>
      {ticket && <TicketPaper db={db} t={ticket} me={me} toast={toast} />}
    </div>
  )
}

// ---------- offline work to check ----------
/** Entries or cash a POS saved without internet that the server could not record as-is. */
export function OfflineChecks({ db }: { db: DB }) {
  const open = (db.offlineIssues ?? []).filter(i => !i.resolved).sort((a, b) => b.at - a.at)
  const [busy, setBusy] = useState('')
  if (!open.length) return null
  return (
    <div className="card stack offline-checks">
      <h2><Ico n="warn" /> Check these <span className="muted">({open.length})</span></h2>
      <p className="tiny muted">Work done at a gate while it had no internet, which clashed with another gate. Check each one, fix the ticket if needed, then mark it checked.</p>
      {open.slice(0, 50).map(i => (
        <div key={i.opId} className="free-row">
          <div><b>{i.ticketId}</b><span className="small">{i.text}</span><span className="muted tiny">{fmtDT(i.at)}{i.device ? ` · POS ${i.device}` : ''}</span></div>
          <button className="btn btn-ghost fit" disabled={busy === i.opId} onClick={async () => { setBusy(i.opId); try { await callParking('resolveOfflineIssue', [i.opId]) } finally { setBusy('') } }}>Mark checked</button>
        </div>))}
    </div>
  )
}
