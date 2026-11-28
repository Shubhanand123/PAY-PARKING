// Owner dashboard: Reports & export, Day closing, Complaints (steps 5–7, 28 Nov 2026).
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { dur, fmtDT, fmtTime, istDay, prettyPlate, rupees, type DB, type Staff, type Ticket } from './engine'
import { NOTES, countTotal, openCash, type Count } from './closing'
import { COMPLAINT_TYPES, SMILEYS, STATUS_LABEL, complaintSummary, RETENTION_DAYS, type Complaint, type ComplaintStatus } from './complaints'
import { REPORTS, buildReport, toCsv, type IssuedReport, type Report, type ReportType } from './reports'
import * as api from './care-api'
import { saveEnd, saveStart } from './done'
import { Ico, Pill, QR, useNow } from './ui'
import './care.css'

type Toast = (message: string, bad?: boolean) => void
const DAY = 864e5
const err = (e: unknown) => (e as Error).message
const plus91 = (m: string) => '+91' + m.replace(/\D/g, '').slice(-10)

// ---------- complaints: overview card ----------
export function ComplaintsCard({ db, onOpen }: { db: DB; onOpen: (id?: string) => void }) {
  const list = db.complaints ?? []
  const open = list.filter(c => c.status === 'new' || c.status === 'open').sort((a, b) => b.at - a.at)
  const month = istDay(Date.now()).slice(0, 7)
  const sum = useMemo(() => complaintSummary(db, month), [db, month])
  if (!list.length && !sum.ratings) return null
  const fresh = open.filter(c => c.status === 'new').length
  return (
    <section className={'card cx-card' + (open.length ? ' has' : '')}>
      <div className="row-between">
        <h2><Ico n="warn" /> Complaints</h2>
        <button className="btn btn-ghost fit" onClick={() => onOpen()}>Open all</button>
      </div>
      <div className="cx-nums">
        <div><b className="num">{open.length}</b><small>open{fresh ? ` · ${fresh} new` : ''}</small></div>
        <div><b className="num">{sum.total}</b><small>this month</small></div>
        <div><b className="num">{sum.avgRating ? sum.avgRating.toFixed(1) : '–'}</b><small>{sum.avgRating ? SMILEYS[Math.round(sum.avgRating) - 1].face + ' ' : ''}rating · {sum.ratings}</small></div>
      </div>
      {open.slice(0, 3).map(c => <button key={c.id} className="listrow" onClick={() => onOpen(c.id)}>
        <StatusPill s={c.status} /><b className="num">{c.id}</b><span>{COMPLAINT_TYPES[c.type]} · {ago(c.at)}</span><Ico n="back" size={16} className="flip" />
      </button>)}
      {!open.length && <p className="muted small">Nothing open. 🎉</p>}
    </section>
  )
}
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${Math.max(1, m)} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : fmtDT(t) }
function StatusPill({ s }: { s: ComplaintStatus }) {
  return <Pill tone={s === 'new' ? 'bad' : s === 'open' ? 'warn' : s === 'resolved' ? 'ok' : 'mute'}>{STATUS_LABEL[s]}</Pill>
}

// ---------- complaints: section ----------
export function Complaints({ db, toast, openId, onTicket }: { db: DB; toast: Toast; openId?: string; onTicket: (id: string) => void }) {
  const [st, setSt] = useState<'active' | 'all' | ComplaintStatus>('active')
  const [sel, setSel] = useState<string | undefined>(openId)
  const [month, setMonth] = useState(istDay(Date.now()).slice(0, 7))
  useEffect(() => { if (openId) setSel(openId) }, [openId])
  const all = (db.complaints ?? []).slice().sort((a, b) => b.at - a.at)
  const list = all.filter(c => st === 'all' || (st === 'active' ? c.status === 'new' || c.status === 'open' : c.status === st))
  const c = sel ? all.find(x => x.id === sel) : undefined
  const sum = useMemo(() => complaintSummary(db, month), [db, month])
  return (
    <div className="stack">
      <div className="card">
        <div className="row-between"><h2>Monthly summary</h2><input type="month" className="field small-field w-auto" value={month} onChange={e => setMonth(e.target.value || month)} /></div>
        <div className="cx-sum">
          <div><small>Complaints</small><b className="num">{sum.total}</b></div>
          <div><small>Average rating</small><b className="num">{sum.avgRating ? sum.avgRating.toFixed(1) + ' / 5' : '–'}</b><span className="cx-faces">{SMILEYS.map((s, i) => <i key={s.score} title={s.label}>{s.face}<em>{sum.ratingCounts[i]}</em></i>)}</span></div>
          <div><small>First reply</small><b className="num">{sum.avgReplyHours != null ? hours(sum.avgReplyHours) : '–'}</b></div>
          <div><small>Resolved in</small><b className="num">{sum.avgResolveHours != null ? hours(sum.avgResolveHours) : '–'}</b></div>
        </div>
        {sum.byType.length > 0 && <div className="cx-bars">{sum.byType.map(t => <div key={t.type}><span>{t.label}</span><i style={{ width: Math.max(6, t.n / sum.total * 100) + '%' }} /><b className="num">{t.n}</b></div>)}</div>}
      </div>
      <div className="card toolbar">
        <select className="field small-field" value={st} onChange={e => setSt(e.target.value as typeof st)}>
          <option value="active">New and in progress</option><option value="all">All</option>
          {(Object.keys(STATUS_LABEL) as ComplaintStatus[]).map(k => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
        </select>
        <span className="muted small">Kept {RETENTION_DAYS} days after closing, then deleted with photos (privacy policy).</span>
      </div>
      <div className="card table-card">
        <table className="tbl">
          <thead><tr><th>Complaint</th><th>Received</th><th>About</th><th>Name</th><th>Ticket</th><th>Status</th></tr></thead>
          <tbody>{list.map(x => <tr key={x.id} className={x.id === sel ? 'sel' : ''} onClick={() => setSel(x.id)}>
            <td className="num">{x.id}</td><td>{fmtDT(x.at)}</td><td>{COMPLAINT_TYPES[x.type]}{x.photos.length > 0 && ` · 📷${x.photos.length}`}</td><td>{x.name}</td><td className="num">{x.ticketId}</td><td><StatusPill s={x.status} /></td>
          </tr>)}</tbody>
        </table>
        {!list.length && <p className="muted small center">No complaints here.</p>}
      </div>
      {c && <ComplaintDetail key={c.id} db={db} c={c} toast={toast} onTicket={onTicket} />}
    </div>
  )
}
const hours = (h: number) => h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`

function ComplaintDetail({ db, c, toast, onTicket }: { db: DB; c: Complaint; toast: Toast; onTicket: (id: string) => void }) {
  const [reply, setReply] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [photo, setPhoto] = useState<{ i: number; url?: string }>()
  const t = db.tickets.find(x => x.id === c.ticketId)
  const rating = (db.ratings ?? []).find(r => r.ticketId === c.ticketId)
  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true); saveStart()
    try { await what(); saveEnd(true, done); return true } catch (e) { saveEnd(false, ''); toast(err(e), true); return false } finally { setBusy(false) }
  }
  const show = async (i: number) => {
    setPhoto({ i })
    try { setPhoto({ i, url: await api.complaintPhoto(c, i) }) } catch (e) { setPhoto(undefined); toast(err(e), true) }
  }
  const wa = `https://wa.me/${plus91(c.mobile).slice(1)}?text=${encodeURIComponent(`Namaste ${c.name}, this is ${db.settings.operator} about your complaint ${c.id}. `)}`
  const thread = [{ at: c.at, from: 'customer' as const, text: c.message }, ...c.messages]
  return (
    <div className="card cx-detail">
      <div className="row-between"><h2 className="num">{c.id}</h2><StatusPill s={c.status} /></div>
      <p className="muted small">{COMPLAINT_TYPES[c.type]} · received {fmtDT(c.at)}{c.firstReplyAt ? ` · first reply after ${hours((c.firstReplyAt - c.at) / 3600_000)}` : ' · not answered yet'}</p>
      <div className="cx-who">
        <div><b>{c.name}</b><span className="num">{plus91(c.mobile)}</span></div>
        <a className="btn btn-ghost fit" href={'tel:' + plus91(c.mobile)}>Call</a>
        <a className="btn btn-ghost fit" href={wa} target="_blank" rel="noreferrer">WhatsApp</a>
      </div>
      <div className="cx-ticket">
        <span>Ticket <b className="num">{c.ticketId}</b>{t && <> · {prettyPlate(t.plate)} · in {fmtDT(t.entryAt)}{t.exitAt ? ` · out ${fmtTime(t.exitAt)}` : ''}{t.totalPaise != null ? ` · ${rupees(t.totalPaise)}` : ''}</>}</span>
        {rating && <span title={SMILEYS[rating.score - 1].label}>Rated {SMILEYS[rating.score - 1].face}{rating.comment ? ` “${rating.comment}”` : ''}</span>}
        <button className="link" onClick={() => onTicket(c.ticketId)}>Open ticket</button>
      </div>
      {c.photos.length > 0 && <div className="cx-photos">{c.photos.map((_, i) => <button key={i} className="cx-thumb" onClick={() => void show(i)}><Ico n="scan" /> Photo {i + 1}</button>)}</div>}
      <div className="cx-thread" aria-label="Conversation with the customer">
        {thread.map((m, i) => <div key={i} className={'cx-msg from-' + m.from}><p>{m.text}</p><small>{m.from === 'owner' ? 'You' : c.name} · {fmtDT(m.at)}</small></div>)}
      </div>
      {c.status !== 'closed' && <>
        <label className="lbl" htmlFor="cx-reply">Reply to the customer <span className="muted">(they see it on their ticket page)</span></label>
        <textarea id="cx-reply" className="field" rows={3} maxLength={1000} value={reply} onChange={e => setReply(e.target.value)} placeholder="Sorry for the trouble. We checked…" />
        <div className="toolbar">
          <button className="btn btn-primary fit" disabled={busy || !reply.trim()} onClick={() => void run(() => api.replyComplaint(c.id, reply, false), 'Sent').then(ok => ok && setReply(''))}>Send reply</button>
          <button className="btn btn-success fit" disabled={busy || !reply.trim()} onClick={() => void run(() => api.replyComplaint(c.id, reply, true), 'Resolved').then(ok => ok && setReply(''))}>Send & mark resolved</button>
        </div>
      </>}
      <div className="toolbar cx-status">
        <span className="muted small">Status:</span>
        {c.status !== 'open' && <button className="btn btn-ghost fit" disabled={busy} onClick={() => void run(() => api.setComplaintStatus(c.id, 'open'), 'Saved')}>{c.status === 'new' ? 'In progress' : 'Reopen'}</button>}
        {(c.status === 'new' || c.status === 'open') && <button className="btn btn-ghost fit" disabled={busy} onClick={() => void run(() => api.setComplaintStatus(c.id, 'resolved'), 'Resolved')}>Resolved</button>}
        {c.status !== 'closed' && <button className="btn btn-ghost fit" disabled={busy} onClick={() => void run(() => api.setComplaintStatus(c.id, 'closed'), 'Closed')}>Close</button>}
      </div>
      <div className="cx-notes">
        <h3><Ico n="lock" size={16} /> Internal notes <small className="muted">· only you see these</small></h3>
        {c.notes.map((n, i) => <div key={i} className="cx-note"><p>{n.text}</p><small>{n.by} · {fmtDT(n.at)}</small></div>)}
        <div className="toolbar">
          <input className="field small-field" maxLength={1000} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Checked CCTV, called customer" />
          <button className="btn btn-ghost fit" disabled={busy || !note.trim()} onClick={() => void run(() => api.noteComplaint(c.id, note), 'Saved').then(ok => ok && setNote(''))}>Add note</button>
        </div>
      </div>
      {photo && createPortal(<div className="cx-viewer" role="dialog" aria-label={`Photo ${photo.i + 1}`} onClick={() => setPhoto(undefined)}>
        {photo.url ? <img src={photo.url} alt={`Photo ${photo.i + 1} of complaint ${c.id}`} /> : <p>Opening photo…</p>}
        <div className="cx-viewer-bar" onClick={e => e.stopPropagation()}>
          <button className="btn btn-ghost fit" disabled={photo.i === 0} onClick={() => void show(photo.i - 1)}>‹ Back</button>
          <span>{photo.i + 1} / {c.photos.length}</span>
          <button className="btn btn-ghost fit" disabled={photo.i >= c.photos.length - 1} onClick={() => void show(photo.i + 1)}>Next ›</button>
          <button className="btn btn-primary fit" onClick={() => setPhoto(undefined)}>Close</button>
        </div>
      </div>, document.body)}
    </div>
  )
}

// ---------- day closing ----------
export function DayClosing({ db, toast }: { db: DB; me: Staff; toast: Toast }) {
  const now = useNow(15000)
  const open = useMemo(() => openCash(db, now), [db, now])
  const [count, setCount] = useState<Count>({ notes: {}, coinsPaise: 0 })
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const counted = countTotal(count)
  const diff = counted - open.expectedPaise
  const touched = counted > 0 || Object.keys(count.notes).length > 0
  const closes = (db.cashCloses ?? []).slice().reverse()
  const save = async () => {
    if (!confirm(`Close the day with ${rupees(counted)} counted${diff ? ` (${diff < 0 ? 'short' : 'over'} ${rupees(Math.abs(diff))})` : ''}? This cannot be changed later.`)) return
    setBusy(true); saveStart()
    try { await api.closeCash(open.expectedPaise, count, note); saveEnd(true, 'Closed'); toast('Day closed. Cash locked.'); setCount({ notes: {}, coinsPaise: 0 }); setNote('') }
    catch (e) { saveEnd(false, ''); toast(err(e), true) } finally { setBusy(false) }
  }
  const setNoteCount = (n: number, v: string) => setCount(c => ({ ...c, notes: { ...c.notes, [`${n}`]: Math.max(0, Math.floor(Number(v) || 0)) } }))
  return (
    <div className="stack">
      <div className="card dc">
        <h2>Close the day</h2>
        <p className="muted small">Count the cash in the drawer. It is checked against the cash the gates recorded {open.last ? <>since the last close (<b>{fmtDT(open.last.at)}</b>)</> : 'so far'}. When you save, that cash is locked and cannot be counted again.</p>
        <div className="dc-expect">
          <div><small>Cash the records expect</small><b className="num">{rupees(open.expectedPaise)}</b><span>{open.payments.length} cash payment{open.payments.length === 1 ? '' : 's'}</span></div>
          <div><small>Online (to bank, not in drawer)</small><b className="num">{rupees(open.onlinePaise)}</b><span>{open.entries} in · {open.exits} out · {open.inside} inside now</span></div>
        </div>
        {open.byWho.length > 0 && <div className="dc-who">{open.byWho.map(w => <span key={w.name}>{w.name} <b className="num">{rupees(w.paise)}</b> <small>({w.n})</small></span>)}</div>}
        {open.late > 0 && <p className="msg warn">{open.late} cash payment{open.late > 1 ? 's were' : ' was'} made before the last close but sent late by a POS that was offline. {open.late > 1 ? 'They are' : 'It is'} included here.</p>}
        <h3>Count</h3>
        <div className="dc-notes">
          {NOTES.map(n => <div className="dc-row" key={n}><label htmlFor={'dc-' + n}>₹{n} ×</label><input id={'dc-' + n} type="number" inputMode="numeric" min={0} className="field small-field" value={count.notes[`${n}`] ?? ''} onChange={e => setNoteCount(n, e.target.value)} /><b className="num">{rupees((count.notes[`${n}`] ?? 0) * n * 100)}</b></div>)}
          <div className="dc-row"><label htmlFor="dc-coins">Coins ₹</label><input id="dc-coins" type="number" inputMode="decimal" min={0} className="field small-field" value={count.coinsPaise ? count.coinsPaise / 100 : ''} onChange={e => setCount(c => ({ ...c, coinsPaise: Math.max(0, Math.round((Number(e.target.value) || 0) * 100)) }))} /><b className="num">{rupees(count.coinsPaise)}</b></div>
        </div>
        <div className={'dc-total ' + (!touched ? '' : diff === 0 ? 'ok' : 'bad')}>
          <div><small>Counted</small><b className="num">{rupees(counted)}</b></div>
          <div><small>{!touched ? 'Difference' : diff === 0 ? 'Matches' : diff < 0 ? 'Short' : 'Over'}</small><b className="num">{touched ? (diff === 0 ? '✓' : rupees(Math.abs(diff))) : '–'}</b></div>
        </div>
        {touched && diff !== 0 && <><label className="lbl" htmlFor="dc-note">Why is it different? <span className="muted">(required)</span></label>
          <input id="dc-note" className="field" maxLength={300} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. ₹50 given as change from own pocket" /></>}
        <button className="btn btn-primary" disabled={busy || !touched || (diff !== 0 && !note.trim())} onClick={() => void save()}><Ico n="lock" /> Close the day and lock {rupees(open.expectedPaise)}</button>
      </div>
      <div className="card table-card">
        <h2>Past closes</h2>
        <table className="tbl">
          <thead><tr><th>No.</th><th>Closed</th><th>Covers from</th><th className="r">Expected</th><th className="r">Counted</th><th className="r">Difference</th><th>Note</th><th>By</th></tr></thead>
          <tbody>{closes.map(c => <tr key={c.id}><td className="num">#{c.no}</td><td>{fmtDT(c.at)}</td><td>{fmtDT(c.from)}</td><td className="r num">{rupees(c.expectedPaise)}</td><td className="r num">{rupees(c.countedPaise)}</td>
            <td className="r num">{c.diffPaise === 0 ? <Pill tone="ok">Matches</Pill> : <Pill tone="bad">{c.diffPaise < 0 ? '−' : '+'}{rupees(Math.abs(c.diffPaise))}</Pill>}</td><td>{c.note ?? ''}{c.late ? ` · ${c.late} sent late` : ''}</td><td>{c.by}</td></tr>)}</tbody>
        </table>
        {!closes.length && <p className="muted small center">No closes yet.</p>}
        <p className="tiny muted">🔒 Closes are permanent. Print them from Reports → Day closing.</p>
      </div>
    </div>
  )
}

// ---------- reports & export ----------
const presets = (now: number): [string, string, string][] => {
  const today = istDay(now), yesterday = istDay(now - DAY)
  const m = today.slice(0, 7)
  const lastMonthEnd = istDay(Date.parse(m + '-01T12:00:00+05:30') - DAY)
  return [['Today', today, today], ['Yesterday', yesterday, yesterday], ['Last 7 days', istDay(now - 6 * DAY), today], ['This month', m + '-01', today], ['Last month', lastMonthEnd.slice(0, 7) + '-01', lastMonthEnd]]
}
function download(name: string, text: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
export const verifyUrl = (code: string) => location.href.split('#')[0] + '#/verify/' + code

export function Reports({ db, toast }: { db: DB; toast: Toast }) {
  const now = Date.now()
  const [type, setType] = useState<ReportType>('payments')
  const [from, setFrom] = useState(istDay(now).slice(0, 7) + '-01')
  const [to, setTo] = useState(istDay(now))
  const [busy, setBusy] = useState(false)
  const [sheet, setSheet] = useState<{ report: Report; issued: IssuedReport }>()
  const preview = useMemo(() => { try { return buildReport(db, type, from, to) } catch (e) { return err(e) } }, [db, type, from, to])
  const name = `SKC-${type}-${from}${to !== from ? '_' + to : ''}.csv`
  useEffect(() => {
    if (!sheet) return
    const after = () => setSheet(undefined)
    addEventListener('afterprint', after)
    const t = setTimeout(() => print(), 400) // let the QR draw first
    return () => { clearTimeout(t); removeEventListener('afterprint', after) }
  }, [sheet])
  const printIt = async () => {
    setBusy(true)
    try { setSheet(await api.issueReport(type, from, to)) } catch (e) { toast(err(e), true) } finally { setBusy(false) }
  }
  return (
    <div className="stack">
      <div className="card">
        <h2>Reports & export</h2>
        <div className="rp-types" role="radiogroup" aria-label="Report">
          {(Object.keys(REPORTS) as ReportType[]).map(k => <button key={k} role="radio" aria-checked={type === k} className={'seg-btn' + (type === k ? ' on' : '')} onClick={() => setType(k)}>{REPORTS[k]}</button>)}
        </div>
        <div className="toolbar rp-dates">
          <label>From <input type="date" className="field small-field" value={from} max={to} onChange={e => setFrom(e.target.value || from)} /></label>
          <label>To <input type="date" className="field small-field" value={to} min={from} onChange={e => setTo(e.target.value || to)} /></label>
          <div className="rp-presets">{presets(now).map(([l, f, t]) => <button key={l} className={'chip' + (f === from && t === to ? ' on' : '')} onClick={() => { setFrom(f); setTo(t) }}>{l}</button>)}</div>
        </div>
        {typeof preview === 'string' ? <p className="msg bad">{preview}</p> : <>
          <div className="rp-totals">{preview.totals.map(([l, v]) => <div key={l}><small>{l}</small><b className="num">{v}</b></div>)}</div>
          {preview.note && <p className="muted small">{preview.note}</p>}
          <div className="toolbar">
            <button className="btn btn-ghost fit" disabled={!preview.rows.length} onClick={() => download(name, toCsv(preview))}><Ico n="dl" /> Download CSV (Excel)</button>
            <button className="btn btn-primary fit" disabled={busy || !preview.rows.length} onClick={() => void printIt()}><Ico n="print" /> {busy ? 'Preparing…' : 'Print / save as PDF'}</button>
          </div>
          <p className="tiny muted">The printed report gets a check code. Anyone can type it at <b>{verifyUrl('').replace(/\/$/, '')}</b> to see it is genuine. In the print window choose “Save as PDF” to keep a file.</p>
        </>}
      </div>
      {typeof preview !== 'string' && <div className="card table-card">
        <h2>Preview <span className="muted">· {preview.rows.length} rows{preview.rows.length > 100 ? ', first 100 shown' : ''}</span></h2>
        <table className="tbl rp-tbl"><thead><tr>{preview.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{preview.rows.slice(0, 100).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody></table>
        {!preview.rows.length && <p className="muted small center">Nothing in these dates.</p>}
      </div>}
      {sheet && createPortal(<ReportSheet db={db} {...sheet} />, document.body)}
    </div>
  )
}

/** The printed report: letterhead, totals, the full table, and the check code with its QR. */
function ReportSheet({ db, report, issued }: { db: DB; report: Report; issued: IssuedReport }) {
  const s = db.settings
  const range = report.from === report.to ? fmtDay(report.from) : `${fmtDay(report.from)} to ${fmtDay(report.to)}`
  return (
    <div className="report-sheet" aria-hidden="true">
      <header className="rs-head">
        <img src="skc.png" alt="SKC" />
        <div><b>{s.operator}</b><span>{s.siteName}{s.address ? ' · ' + s.address : ''}</span><span>{s.phone}{s.gstin ? ' · GSTIN ' + s.gstin : ''}</span></div>
      </header>
      <h1>{report.title} <small>{range}</small></h1>
      <div className="rs-totals">{report.totals.map(([l, v]) => <div key={l}><small>{l}</small><b>{v}</b></div>)}</div>
      {report.note && <p className="rs-note">{report.note}</p>}
      <table><thead><tr>{report.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>{report.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody></table>
      <footer className="rs-foot">
        <QR text={verifyUrl(issued.code)} size={84} />
        <div>
          <b>Check code {issued.code}</b>
          <span>Printed {fmtDT(issued.at)} by {issued.by} · {issued.rows} rows · fingerprint {issued.digest.slice(0, 16)}</span>
          <span>To check this report is genuine, scan the QR or open {verifyUrl(issued.code)}</span>
        </div>
      </footer>
    </div>
  )
}
const fmtDay = (d: string) => new Date(d + 'T12:00:00+05:30').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })

// ---------- step 4: all visits of one vehicle ----------
export function VehicleVisits({ db, plate, onOpen }: { db: DB; plate: string; onOpen: (t: Ticket) => void }) {
  const [list, setList] = useState<Ticket[]>()
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setList(undefined)
    api.historyTickets('vehicleHistory', plate, db).then(r => { if (alive) setList(r) }).catch(e => { if (alive) setError(err(e)) })
    return () => { alive = false }
  }, [plate]) // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="msg bad">{error}</p>
  if (!list) return <p className="muted small">Loading visits…</p>
  const paid = list.reduce((s, t) => s + (t.status === 'cancelled' ? 0 : t.totalPaise ?? 0), 0)
  const time = list.reduce((s, t) => s + ((t.exitAt ?? t.billedAt ?? t.entryAt) - t.entryAt), 0)
  return (
    <div className="stack">
      <p className="muted small"><b>{prettyPlate(plate)}</b> · {list.length} visit{list.length === 1 ? '' : 's'} · {dur(time)} parked · {rupees(paid)} paid</p>
      <table className="tbl"><thead><tr><th>Ticket</th><th>In</th><th>Out</th><th className="r">Amount</th><th>Status</th></tr></thead>
        <tbody>{list.map(t => <tr key={t.id} onClick={() => onOpen(t)}><td className="num">{t.id}</td><td>{fmtDT(t.entryAt)}</td><td>{t.exitAt ? fmtDT(t.exitAt) : ''}</td><td className="r num">{t.totalPaise != null ? rupees(t.totalPaise) : ''}</td><td>{t.status}</td></tr>)}</tbody></table>
    </div>
  )
}
