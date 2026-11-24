import { indianMobile } from './parking-auth'
import { apiEnabled, callParking, openAccess } from './parking-api'
import { publishTariff, saveSettings } from './actions'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import {
  activeTariff, billFor, charge, dur, fmtDT, fmtTime, istDay, istHour, prettyPlate, rupees,
  type AuditKind, type DB, type Rate, type Settings, type Staff, type Ticket,
} from './engine'
import { Ico, Pill, QR, useNow } from './ui'
import { StatusPill } from './Gate'
import { saveStart, saveEnd } from './done'
import { Customers, FreeVehicles, OfflineChecks, TicketPaper } from './OwnerExtras'

type Tab = 'overview' | 'tickets' | 'customers' | 'free' | 'audit' | 'rates' | 'settings' | 'devices'

export function Owner({ db, me, toast }: { db: DB; me: Staff; toast: (m: string, bad?: boolean) => void }) {
  const [tab, setTab] = useState<Tab>('overview')
  const tabs: [Tab, string, string][] = [['overview', 'Overview', 'chart'], ['tickets', 'Tickets', 'list'], ['customers', 'Customers', 'car'], ['free', 'Free vehicles', 'check'], ['audit', 'Activity log', 'list'], ['rates', 'Rates', 'rupee'], ['settings', 'Settings', 'gear']]
  if (apiEnabled) tabs.push(['devices', 'POS devices', 'key'])
  return (
    <div className="owner">
      <nav className="tabs" aria-label="Owner sections">
        {tabs.map(([k, l, i]) => <button key={k} className={'tab' + (tab === k ? ' on' : '')} onClick={() => setTab(k)} aria-current={tab === k}><Ico n={i} size={18} />{l}</button>)}
      </nav>
      <div className="owner-panel">
      {tab === 'overview' && <><OfflineChecks db={db} /><Overview db={db} live={<LiveActivity db={db} onAll={() => setTab('audit')} />} /></>}
      {tab === 'tickets' && <Tickets db={db} me={me} toast={toast} />}
      {tab === 'customers' && <Customers db={db} me={me} toast={toast} />}
      {tab === 'free' && <FreeVehicles db={db} me={me} toast={toast} />}
      {tab === 'audit' && <AuditLog db={db} />}
      {tab === 'rates' && <Rates db={db} me={me} toast={toast} />}
      {tab === 'devices' && <div className="stack"><GateLockCard db={db} toast={toast} /><DevicesTab toast={toast} />{!openAccess && <><OwnerAccessTab toast={toast} /><AccountsTab toast={toast} /></>}</div>}
      {tab === 'settings' && <SettingsTab db={db} me={me} toast={toast} />}
      </div>
    </div>
  )
}

// ---------- overview ----------
function Overview({ db, live }: { db: DB; live?: ReactNode }) {
  const now = useNow(30000)
  const today = istDay(now)
  const s = useMemo(() => {
    const inside = db.tickets.filter(t => t.status === 'inside' || t.status === 'paid')
    const tIn = db.tickets.filter(t => istDay(t.entryAt) === today)
    const tOut = db.tickets.filter(t => t.status === 'exited' && istDay(t.exitAt!) === today)
    const paymentsToday = db.payments.filter(p => istDay(p.at) === today)
    const cash = paymentsToday.filter(p => p.method === 'cash').reduce((a, p) => a + p.amountPaise, 0)
    const online = paymentsToday.filter(p => p.method === 'razorpay').reduce((a, p) => a + p.amountPaise, 0)
    const cancels = db.tickets.filter(t => t.status === 'cancelled' && istDay(t.cancelledAt!) === today).length
    const avg = tOut.length ? tOut.reduce((a, t) => a + (t.exitAt! - t.entryAt), 0) / tOut.length : 0
    const lostSlip = db.audit.filter(a => a.kind === 'lookup_plate' && istDay(a.at) === today).length
    const reprints = db.audit.filter(a => a.kind === 'reprint' && istDay(a.at) === today).length
    const receiptReprints = db.audit.filter(a => a.kind === 'receipt_reprint' && istDay(a.at) === today).length
    const freeToday = db.tickets.filter(t => t.free && t.billedAt && istDay(t.billedAt) === today)
    const waivedToday = freeToday.reduce((sum, t) => sum + (t.free?.waivedPaise ?? 0), 0)
    const days = Array.from({ length: 7 }, (_, i) => istDay(now - (6 - i) * 864e5))
    const daily = days.map(d => ({ d, v: db.payments.filter(p => istDay(p.at) === d).reduce((a, p) => a + p.amountPaise, 0), n: db.tickets.filter(t => istDay(t.entryAt) === d).length }))
    const hours = Array.from({ length: 24 }, (_, h) => ({ h, i: tIn.filter(t => istHour(t.entryAt) === h).length, o: tOut.filter(t => istHour(t.exitAt!) === h).length }))
    const byCat = db.categories.map(c => ({ name: c.name, icon: c.icon, n: inside.filter(t => t.category === c.id).length, rev: db.payments.filter(p => istDay(p.at) === today && db.tickets.find(t => t.id === p.ticketId)?.category === c.id).reduce((a, p) => a + p.amountPaise, 0) }))
    const longStay = inside.filter(t => now - t.entryAt > 12 * 36e5)
    const openRunning = inside.reduce((a, t) => a + billFor(db, t, now).duePaise, 0)
    return { inside, tIn, tOut, cash, online, cancels, avg, lostSlip, reprints, receiptReprints, freeToday, waivedToday, daily, hours, byCat, longStay, openRunning }
  }, [db, now, today])
  const cap = db.settings.capacity
  const occ = cap ? s.inside.length / cap : 0

  const needs = s.longStay.length > 0 || s.cancels > 3
  return (
    <div className="stack ov">
      {/* 1. Today at a glance */}
      <div className="ov-hero">
        <div className="ov-money">
          <span className="ov-l">Collected today</span>
          <b className="ov-big num">{rupees(s.cash + s.online)}</b>
          <div className="ov-split"><span><i className="dot cash" />Cash <b className="num">{rupees(s.cash)}</b></span><span><i className="dot upi" />UPI <b className="num">{rupees(s.online)}</b></span></div>
        </div>
        <div className="ov-side">
          <div><span className="ov-l">Inside now</span><b className="num">{s.inside.length}</b><small>{cap ? `of ${cap} spaces` : 'vehicles'}</small></div>
          <div><span className="ov-l">Entries today</span><b className="num">{s.tIn.length}</b><small>{s.tOut.length} left</small></div>
        </div>
      </div>
      {/* 2. Small numbers */}
      <div className="ov-chips">
        <span><Ico n="rupee" size={16} />Due from inside <b className="num">{rupees(s.openRunning)}</b></span>
        <span><Ico n="clock" size={16} />Average stay <b className="num">{s.avg ? dur(s.avg) : '–'}</b></span>
        <span><Ico n="check" size={16} />Free exits <b className="num">{s.freeToday.length}</b></span>
        <span className={s.cancels > 3 ? 'warn' : ''}><Ico n="x" size={16} />Cancels <b className="num">{s.cancels}</b></span>
        <span className={s.reprints + s.receiptReprints > 5 ? 'warn' : ''}><Ico n="print" size={16} />Reprints <b className="num">{s.reprints + s.receiptReprints}</b></span>
      </div>
      {/* 3. Anything unusual */}
      {needs && <div className="card ov-needs">
        <h2><Ico n="warn" /> Needs a look</h2>
        {s.longStay.map(t => <div key={t.id} className="listrow static"><Ico n="clock" /><b>{prettyPlate(t.plate)}</b><span>inside {dur(now - t.entryAt)}</span><Pill tone="warn">Long stay</Pill></div>)}
        {s.cancels > 3 && <div className="listrow static"><Ico n="warn" /><b>{s.cancels} cancels today</b><span>See the Activity log</span></div>}
      </div>}
      {/* 4. What is happening */}
      {live}
      {/* 5. Charts */}
      <div className="grid2">
        <div className="card">
          <h2>Collections, last 7 days</h2>
          <Bars data={s.daily.map(d => ({ label: new Date(d.d + 'T12:00:00+05:30').toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' }), v: d.v / 100, tip: `${rupees(d.v)} · ${d.n} vehicles` }))} fmt={v => '₹' + Math.round(v).toLocaleString('en-IN')} />
        </div>
        <div className="card">
          <h2>Today by hour</h2>
          <p className="muted small">Entries and exits each hour. Busy hours show when to add staff.</p>
          <Lines hours={s.hours} />
        </div>
      </div>
      <div className="grid2">
        <div className="card">
          <h2>Today by vehicle type</h2>
          <Donut parts={s.byCat.map((c, i) => ({ label: c.name, v: c.rev, color: `var(--color-chart-${i + 1})` }))} />
        </div>
        {cap > 0 && <div className="card">
          <h2>Occupancy</h2>
          <Gauge v={occ} label={`${Math.round(occ * 100)}%`} sub={`${s.inside.length} of ${cap}`} />
          <div className="legend">{s.byCat.filter(c => c.n).map(c => <span key={c.name}><Ico n={c.icon} size={16} /> {c.name} <b>{c.n}</b></span>)}</div>
        </div>}
      </div>
    </div>
  )
}

function Gauge({ v, label, sub }: { v: number; label: string; sub: string }) {
  const r = 70, c = Math.PI * r, f = Math.min(1, v)
  const tone = v > 0.9 ? 'var(--color-danger-solid)' : v > 0.75 ? 'var(--color-warning-solid)' : 'var(--color-accent-solid)'
  return (
    <svg viewBox="0 0 180 110" className="gauge" role="img" aria-label={`Occupancy ${label}`}>
      <path d="M20 95a70 70 0 0 1 140 0" className="g-bg" />
      <path d="M20 95a70 70 0 0 1 140 0" style={{ stroke: tone, strokeDasharray: `${c * f} ${c}` }} className="g-fg" />
      <text x="90" y="82" textAnchor="middle" className="g-v">{label}</text>
      <text x="90" y="104" textAnchor="middle" className="g-s">{sub}</text>
    </svg>
  )
}

function Bars({ data, fmt }: { data: { label: string; v: number; tip: string }[]; fmt: (v: number) => string }) {
  const max = Math.max(1, ...data.map(d => d.v))
  return (
    <div className="bars" role="img" aria-label="Bar chart of daily collections">
      {data.map((d, i) => (
        <div key={i} className="bar-col" title={d.tip}>
          <span className="bar-v num">{fmt(d.v)}</span>
          <div className="bar" style={{ height: `${(d.v / max) * 100}%` }} data-last={i === data.length - 1} />
          <span className="bar-l">{d.label}</span>
        </div>
      ))}
    </div>
  )
}

function Lines({ hours }: { hours: { h: number; i: number; o: number }[] }) {
  const W = 1000, H = 220, max = Math.max(2, ...hours.flatMap(h => [h.i, h.o]))
  const x = (h: number) => 20 + (h / 23) * (W - 40), y = (v: number) => H - 20 - (v / max) * (H - 40)
  const path = (k: 'i' | 'o') => hours.map((h, j) => `${j ? 'L' : 'M'}${x(h.h)} ${y(h[k])}`).join('')
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="lines" role="img" aria-label="Entries and exits by hour">
        {[0, .5, 1].map(f => <line key={f} x1="20" x2={W - 20} y1={y(max * f)} y2={y(max * f)} className="grid" />)}
        <path d={path('i') + `L${x(23)} ${H - 20}L${x(0)} ${H - 20}Z`} className="area" />
        <path d={path('i')} className="l1" /><path d={path('o')} className="l2" />
        {[0, 6, 12, 18, 23].map(h => <text key={h} x={x(h)} y={H - 4} textAnchor="middle" className="ax">{h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p'}</text>)}
      </svg>
      <div className="legend"><span><i className="sw sw1" /> Entries</span><span><i className="sw sw2" /> Exits</span></div>
    </div>
  )
}

function Donut({ parts }: { parts: { label: string; v: number; color: string }[] }) {
  const tot = parts.reduce((a, p) => a + p.v, 0)
  if (!tot) return <Empty text="No payments collected yet today." />
  let acc = 0
  const R = 52, C = 2 * Math.PI * R
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 140 140" className="donut" role="img" aria-label="Collections by vehicle type">
        {parts.filter(p => p.v).map((p, i) => { const len = (p.v / tot) * C; const el = <circle key={i} cx="70" cy="70" r={R} style={{ stroke: p.color, strokeDasharray: `${Math.max(0, len - 2)} ${C}`, strokeDashoffset: -acc }} />; acc += len; return el })}
        <text x="70" y="68" textAnchor="middle" className="g-v sm">{rupees(tot)}</text><text x="70" y="86" textAnchor="middle" className="g-s">today</text>
      </svg>
      <div className="dl">{parts.filter(p => p.v).map(p => <div key={p.label}><i style={{ background: p.color }} />{p.label}<b className="num">{rupees(p.v)}</b><span className="muted">{Math.round(p.v / tot * 100)}%</span></div>)}</div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <svg viewBox="0 0 120 60" aria-hidden="true"><rect x="10" y="38" width="100" height="4" rx="2" className="e-road" /><g className="e-car"><path d="M30 36v-6l5-8h30l6 8v6z" /><circle cx="40" cy="38" r="5" /><circle cx="64" cy="38" r="5" /></g></svg>
      <p className="muted small">{text}</p>
    </div>
  )
}

// ---------- tickets ----------
function Tickets({ db, me, toast }: { db: DB; me: Staff; toast: (m: string, bad?: boolean) => void }) {
  const [q, setQ] = useState('')
  const [st, setSt] = useState<'all' | Ticket['status']>('all')
  const [open, setOpen] = useState<string | null>(null)
  const list = db.tickets.filter(t => (st === 'all' || t.status === st) && (!q || t.plate.includes(q.toUpperCase().replace(/[^A-Z0-9]/g, '')) || t.id.includes(q.toUpperCase()))).slice().reverse()
  const sel = open ? db.tickets.find(t => t.id === open) : undefined
  return (
    <div className="stack">
      <div className="card toolbar">
        <input className="field small-field" placeholder="Search plate or ticket" value={q} onChange={e => setQ(e.target.value)} />
        <select className="field small-field" value={st} onChange={e => setSt(e.target.value as typeof st)}>
          <option value="all">All</option><option value="inside">Inside</option><option value="paid">Paid, not left</option><option value="exited">Closed</option><option value="cancelled">Cancelled</option>
        </select>
        <button className="btn btn-ghost fit" onClick={() => csv(db)}><Ico n="dl" /> Today's CSV</button>
      </div>
      <div className="card table-card">
        <table className="tbl">
          <thead><tr><th>Ticket</th><th>Plate</th><th>Type</th><th>Entry</th><th>Exit</th><th className="r">Amount</th><th>Status</th></tr></thead>
          <tbody>{list.slice(0, 200).map(t => (
            <tr key={t.id} onClick={() => setOpen(t.id)} className={open === t.id ? 'sel' : ''}>
              <td>{t.id}</td><td><b>{prettyPlate(t.plate)}</b></td><td>{db.categories.find(c => c.id === t.category)?.name}</td>
              <td>{fmtDT(t.entryAt)}</td><td>{t.exitAt ? fmtTime(t.exitAt) : '–'}</td><td className="r num">{t.totalPaise != null ? rupees(t.totalPaise) : '–'}</td><td><StatusPill t={t} /></td>
            </tr>))}</tbody>
        </table>
        {!list.length && <Empty text="No tickets match." />}
      </div>
      {sel && <div className="grid2">
        <div className="card"><h2>History of {sel.id}</h2>{db.audit.filter(a => a.ticketId === sel.id).map(a => <AuditRow key={a.id} a={a} />)}</div>
        <TicketPaper db={db} t={sel} me={me} toast={toast} />
      </div>}
    </div>
  )
}

function csv(db: DB) {
  const today = istDay(Date.now())
  const rows = [['ticket', 'plate', 'type', 'entry_ist', 'exit_ist', 'status', 'total_rupees', 'cash_rupees', 'razorpay_rupees', 'entry_by', 'exit_by', 'tariff_version']]
  db.tickets.filter(t => istDay(t.entryAt) === today || (t.exitAt && istDay(t.exitAt) === today)).forEach(t => rows.push([
    t.id, prettyPlate(t.plate), db.categories.find(c => c.id === t.category)?.name ?? '', fmtDT(t.entryAt), t.exitAt ? fmtDT(t.exitAt) : '', t.status,
    t.totalPaise != null ? (t.totalPaise / 100).toFixed(2) : '', ...(['cash', 'razorpay'] as const).map(method => (db.payments.filter(p => p.ticketId === t.id && p.method === method).reduce((a, p) => a + p.amountPaise, 0) / 100).toFixed(2)),
    t.entryBy, t.exitBy ?? '', String(db.tariffs.find(x => x.id === t.tariffId)?.version ?? ''),
  ]))
  const blob = new Blob([rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `parking-${today}.csv`; a.click()
}

// ---------- master audit ----------
const KIND: Record<AuditKind, [string, 'ok' | 'warn' | 'bad' | 'info' | 'mute']> = {
  entry: ['Entry', 'info'], print: ['Print', 'mute'], reprint: ['Reprint', 'warn'], lookup_plate: ['Plate lookup', 'warn'], lookup_qr: ['Opened', 'mute'],
  plate_fix: ['Plate fixed', 'warn'], payment: ['Payment', 'ok'], exit: ['Exit', 'ok'], cancel: ['Cancel', 'bad'], tariff: ['Rates', 'warn'],
  settings: ['Settings', 'warn'], duplicate_blocked: ['Duplicate blocked', 'warn'], login: ['Login', 'mute'],
  receipt_print: ['Receipt', 'mute'], receipt_reprint: ['Receipt reprint', 'warn'], free_vehicle: ['Free list', 'warn'],
}
const ago = (t: number, now: number) => { const m = Math.round((now - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.floor(m / 60)} h ago` : fmtDT(t) }
const KIND_ICON: Partial<Record<AuditKind, string>> = { entry: 'car', exit: 'out', payment: 'cash', cancel: 'x', print: 'print', reprint: 'print', receipt_print: 'print', receipt_reprint: 'print', tariff: 'rupee', settings: 'gear', free_vehicle: 'check', lookup_plate: 'search', lookup_qr: 'qr', duplicate_blocked: 'warn', plate_fix: 'scan', login: 'key' }
function AuditRow({ a, now }: { a: DB['audit'][number]; now?: number }) {
  const [l, tone] = KIND[a.kind]
  return <div className={'arow tone-' + tone}>
    <span className="a-ico"><Ico n={KIND_ICON[a.kind] ?? 'list'} size={18} /></span>
    <div className="a-main"><div className="a-x"><Pill tone={tone}>{l}</Pill> {a.text}</div>
      <div className="a-meta"><b>{a.by}</b>{a.ticketId ? ` · ${a.ticketId}` : ''}{a.amountPaise ? ` · ${rupees(a.amountPaise)}` : ''}</div></div>
    <span className="a-t num" title={fmtDT(a.at)}>{now ? ago(a.at, now) : fmtTime(a.at)}</span>
  </div>
}

/** Overview card: the latest things that happened, live. */
function LiveActivity({ db, onAll }: { db: DB; onAll: () => void }) {
  const now = useNow(15000)
  const latest = db.audit.filter(a => a.kind !== 'print' && a.kind !== 'receipt_print').slice(-8).reverse()
  return <div className="card live-activity">
    <div className="bill-head"><h2><span className="live-dot" /> Live activity</h2><button className="link" onClick={onAll}>See all</button></div>
    {latest.map(a => <AuditRow key={a.id} a={a} now={now} />)}
    {!latest.length && <p className="muted small">Nothing yet today. Entries, payments and exits appear here as they happen.</p>}
  </div>
}

type What = 'all' | 'money' | 'gate' | 'risk'
const WHAT: [What, string][] = [['all', 'Everything'], ['gate', 'Entries & exits'], ['money', 'Money'], ['risk', 'To check']]
const RISK: AuditKind[] = ['cancel', 'reprint', 'receipt_reprint', 'free_vehicle', 'lookup_plate', 'tariff', 'settings', 'duplicate_blocked', 'plate_fix']

/** Every action on every POS and in the dashboard: what happened, who did it, when. Nobody can edit or delete it. */
function AuditLog({ db }: { db: DB }) {
  const now = useNow(15000)
  const [what, setWhat] = useState<What>('all')
  const [who, setWho] = useState('all')
  const [days, setDays] = useState(1)
  const [q, setQ] = useState('')
  const today = istDay(now)
  const since = days === 0 ? 0 : days === 1 ? new Date(today + 'T00:00:00+05:30').getTime() : now - days * 86400000
  const people = useMemo(() => [...new Set(db.audit.map(a => a.by))].sort(), [db.audit])
  // Normal slip and receipt prints are routine: hidden. Reprints stay (they are worth checking).
  const list = db.audit.filter(a => a.kind !== 'print' && a.kind !== 'receipt_print' && a.at >= since
    && (what === 'all' || (what === 'money' ? ['payment', 'exit'].includes(a.kind) : what === 'gate' ? ['entry', 'exit', 'payment'].includes(a.kind) : RISK.includes(a.kind)))
    && (who === 'all' || a.by === who) && (!q || (a.text + ' ' + (a.ticketId ?? '') + ' ' + a.by).toLowerCase().includes(q.toLowerCase()))).slice().reverse()
  const byPerson = people.map(name => {
    const mine = db.audit.filter(a => a.by === name && a.at >= since)
    const pays = db.payments.filter(p => p.by === name && p.at >= since)
    return { name, entries: mine.filter(a => a.kind === 'entry').length, exits: mine.filter(a => a.kind === 'exit').length,
      cash: pays.filter(p => p.method === 'cash').reduce((a, p) => a + p.amountPaise, 0), upi: pays.filter(p => p.method === 'razorpay').reduce((a, p) => a + p.amountPaise, 0),
      flags: mine.filter(a => RISK.includes(a.kind)).length, last: mine.length ? mine[mine.length - 1].at : 0 }
  }).filter(p => p.last).sort((a, b) => b.last - a.last)
  const groups: [string, typeof list][] = []
  for (const a of list.slice(0, 400)) { const d = istDay(a.at); const g = groups[groups.length - 1]; if (g && g[0] === d) g[1].push(a); else groups.push([d, [a]]) }
  return (
    <div className="stack">
      <div className="card stack">
        <h2 className="log-title"><span className="live-dot" /> Activity log</h2>
        <p className="muted tiny log-sub">Every action on every POS and in this dashboard: what happened, who did it, when. Updates by itself. Nobody can edit or delete it.</p>
        <div className="chips">{WHAT.map(([k, l]) => <button key={k} className={'chip' + (what === k ? ' on' : '')} aria-pressed={what === k} onClick={() => setWhat(k)}>{l}</button>)}</div>
        <div className="log-filters">
          <select className="field small-field" value={who} onChange={e => setWho(e.target.value)} aria-label="Who"><option value="all">Everyone</option>{people.map(p => <option key={p} value={p}>{p}</option>)}</select>
          <select className="field small-field" value={days} onChange={e => setDays(Number(e.target.value))} aria-label="When"><option value={1}>Today</option><option value={2}>Last 2 days</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={0}>All time</option></select>
          <input className="field small-field" placeholder="Search plate, ticket, text" value={q} onChange={e => setQ(e.target.value)} aria-label="Search" />
        </div>
      </div>
      {byPerson.length > 0 && <div className="card table-card">
        <h2>Who did what <span className="muted small">({days === 1 ? 'today' : days === 0 ? 'all time' : `last ${days} days`})</span></h2>
        <table className="tbl"><thead><tr><th>Who</th><th className="r">Entries</th><th className="r">Exits</th><th className="r">Cash</th><th className="r">UPI</th><th className="r">To check</th><th>Last</th></tr></thead>
          <tbody>{byPerson.map(p => <tr key={p.name} onClick={() => setWho(p.name)} className={who === p.name ? 'sel' : ''}><td><b>{p.name}</b></td><td className="r num">{p.entries}</td><td className="r num">{p.exits}</td><td className="r num">{rupees(p.cash)}</td><td className="r num">{rupees(p.upi)}</td><td className="r num">{p.flags ? <Pill tone="warn">{p.flags}</Pill> : 0}</td><td className="muted small">{ago(p.last, now)}</td></tr>)}</tbody></table>
      </div>}
      <div className="card log-feed">
        {groups.map(([d, items]) => <div key={d} className="log-day"><div className="log-date">{d === today ? 'Today' : fmtDT(items[0].at).split(',')[0]} <span className="muted">· {items.length}</span></div>{items.map(a => <AuditRow key={a.id} a={a} now={now} />)}</div>)}
        {!list.length && <Empty text="Nothing matches. Try Everything or a longer time." />}
        {list.length > 400 && <p className="tiny muted center">Showing the latest 400. Narrow it down with the filters.</p>}
      </div>
    </div>
  )
}

// ---------- rates + simulator ----------
function Rates({ db, me, toast }: { db: DB; me: Staff; toast: (m: string, bad?: boolean) => void }) {
  const tv = activeTariff(db)
  const [grace, setGrace] = useState(tv.graceMin)
  const [rates, setRates] = useState<Record<string, Rate>>(() => JSON.parse(JSON.stringify(tv.rates)))
  const [note, setNote] = useState('')
  const [simCat, setSimCat] = useState('car')
  const [inT, setInT] = useState('10:00'); const [outT, setOutT] = useState('11:20'); const [days, setDays] = useState(0)
  const set = (c: string, k: keyof Rate, v: string) => setRates(r => ({ ...r, [c]: { ...r[c], [k]: k === 'firstHours' ? Math.max(1, Number(v) || 1) : Math.round((Number(v) || 0) * 100) } }))
  const mins = (() => { const [a, b] = inT.split(':').map(Number), [c, d] = outT.split(':').map(Number); return days * 1440 + (c * 60 + d) - (a * 60 + b) })()
  const sim = mins >= 0 ? charge(mins, rates[simCat], grace) : null
  const dirty = grace !== tv.graceMin || JSON.stringify(rates) !== JSON.stringify(tv.rates)
  return (
    <div className="stack">
      <div className="card">
        <h2>Rates <span className="muted">· live version {tv.version}</span></h2>
        <p className="muted small">Each vehicle pays the version that was live when it came in. Publishing makes a new version; old tickets are not affected.</p>
        <div className="grace"><label className="lbl" htmlFor="gr">Grace period (minutes, free)</label><input id="gr" type="number" min={0} className="field small-field w100" value={grace} onChange={e => setGrace(Math.max(0, Number(e.target.value)))} /></div>
        <div className="table-card"><table className="tbl rates">
          <thead><tr><th>Vehicle</th><th>First slab (hours)</th><th>Slab price ₹</th><th>Each extra hour ₹</th><th>Max per 24h ₹</th></tr></thead>
          <tbody>{db.categories.map(c => <tr key={c.id}><td><Ico n={c.icon} size={18} /> {c.name}</td>
            <td><input type="number" min={1} className="field small-field" value={rates[c.id].firstHours} onChange={e => set(c.id, 'firstHours', e.target.value)} /></td>
            <td><input type="number" min={0} className="field small-field" value={rates[c.id].firstPaise / 100} onChange={e => set(c.id, 'firstPaise', e.target.value)} /></td>
            <td><input type="number" min={0} className="field small-field" value={rates[c.id].perHourPaise / 100} onChange={e => set(c.id, 'perHourPaise', e.target.value)} /></td>
            <td><input type="number" min={0} className="field small-field" value={rates[c.id].capPaise / 100} onChange={e => set(c.id, 'capPaise', e.target.value)} /></td></tr>)}</tbody>
        </table></div>
        <div className="toolbar"><input className="field small-field" placeholder="Note, e.g. Diwali rates" value={note} onChange={e => setNote(e.target.value)} />
          <button className="btn btn-primary fit" disabled={!dirty} onClick={async () => { saveStart(); try { await publishTariff(me.id, grace, rates, note); setNote(''); saveEnd(true, 'Published') } catch (e) { saveEnd(false, ''); toast((e as Error).message, true) } }}>Publish as v{tv.version + 1}</button></div>
      </div>
      <div className="grid2">
        <div className="card">
          <h2>Rate tester</h2>
          <p className="muted small">Uses the rates above (including unpublished edits). Check a bill before you publish.</p>
          <div className="sim">
            <select className="field small-field" value={simCat} onChange={e => setSimCat(e.target.value)}>{db.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <label>In <input type="time" className="field small-field" value={inT} onChange={e => setInT(e.target.value)} /></label>
            <label>Out <input type="time" className="field small-field" value={outT} onChange={e => setOutT(e.target.value)} /></label>
            <label>+ days <input type="number" min={0} className="field small-field w70" value={days} onChange={e => setDays(Math.max(0, Number(e.target.value)))} /></label>
          </div>
          {sim ? <div className="simres">
            <div className="muted small">Stay {dur(mins * 60000)}</div>
            {sim.lines.map((l, i) => <div key={i} className="line"><span>{l.label}</span><b className="num">{rupees(l.paise)}</b></div>)}
            <div className="line total"><span>Bill</span><b className="num">{rupees(sim.total)}</b></div>
          </div> : <p className="muted">Out time is before in time. Add a day.</p>}
        </div>
        <div className="card">
          <h2>Version history</h2>
          {db.tariffs.slice().reverse().map(v => <div key={v.id} className="listrow static"><Pill tone={v.id === tv.id ? 'ok' : 'mute'}>v{v.version}</Pill><span>{fmtDT(v.createdAt)} · {v.createdBy}{v.note ? ` · ${v.note}` : ''}</span><span className="muted">car {rupees(v.rates.car.firstPaise)}/{v.rates.car.firstHours}h, grace {v.graceMin}m</span></div>)}
        </div>
      </div>
    </div>
  )
}

// ---------- settings ----------
function SettingsTab({ db, me, toast }: { db: DB; me: Staff; toast: (m: string, bad?: boolean) => void }) {
  const [s, setS] = useState<Settings>(db.settings)
  const [saving, setSaving] = useState(false)
  const changed = Object.keys(s).some(k => s[k as keyof Settings] !== db.settings[k as keyof Settings])
  const gstOk = !s.gstin || /^[0-9]{2}[A-Z0-9]{13}$/.test(s.gstin)
  const f = (k: keyof Settings, label: string, type = 'text') => <label className="setf"><span className="lbl">{label}</span><input className="field small-field" type={type} value={String(s[k])} onChange={e => setS({ ...s, [k]: type === 'number' ? Number(e.target.value) : e.target.value })} /></label>
  const tg = (k: 'payAtEntry' | 'cancelNeedsReason', label: string, help: string) => <label className="toggle"><input type="checkbox" checked={s[k]} onChange={e => setS({ ...s, [k]: e.target.checked })} /><span className="tg-ui" /><span><b>{label}</b><br /><span className="muted small">{help}</span></span></label>
  return (
    <div className="stack">
      <div className="card">
        <h2>How the gates work</h2>
        {tg('payAtEntry', 'Allow cash before parking', 'After saving, the Entry gate offers Pay before parking or Pay at exit for each vehicle.')}
        {tg('cancelNeedsReason', 'Require a reason to cancel a ticket', 'Off: attendants can cancel without typing anything. Every cancel is still in the master audit.')}
      </div>
      <div className="card grid2">
        {f('operator', 'Company name')}{f('siteName', 'Site name')}{f('address', 'Address')}{f('phone', 'Phone')}
        <label className="setf"><span className="lbl">GST number (GSTIN)</span>
          <input className="field small-field" value={s.gstin ?? ''} maxLength={15} autoCapitalize="characters" placeholder="e.g. 30ABCDE1234F1Z5" onChange={e => setS({ ...s, gstin: e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '') })} />
          <span className="tiny muted">{!s.gstin ? 'Optional. Printed on every slip and receipt.' : gstOk ? 'Printed on every slip and receipt.' : 'A GSTIN has 15 characters, e.g. 30ABCDE1234F1Z5.'}</span>
        </label>
      </div>
      <div className="card stack">
        <label className="toggle"><input type="checkbox" checked={s.capacity > 0} onChange={e => setS({ ...s, capacity: e.target.checked ? (db.settings.capacity || 100) : 0 })} /><span className="tg-ui" /><span><b>Track number of parking spaces</b><br /><span className="muted small">Off: the dashboard shows only how many vehicles are inside, with no total or % full.</span></span></label>
        {s.capacity > 0 && f('capacity', 'Total spaces', 'number')}
      </div>
      <button className="btn btn-primary" disabled={!changed || saving || !gstOk} onClick={async () => {
        setSaving(true)
        saveStart()
        try {
          await saveSettings(me.id, { ...s, gstin: s.gstin ? s.gstin : undefined })
          saveEnd(true, 'Saved')
          toast('Parking settings saved')
        } catch (error) {
          saveEnd(false, '')
          toast((error as Error).message, true)
        } finally {
          setSaving(false)
        }
      }}>{saving ? 'Saving…' : 'Save settings'}</button>
    </div>
  )
}

type ParkingDevice = {
  id: string
  label: string
  role: 'owner' | 'entry' | 'exit' | 'both'
  enabled: boolean
  current: boolean
  pending: boolean
}

function DevicesTab({ toast }: { toast: (message: string, bad?: boolean) => void }) {
  const [devices, setDevices] = useState<ParkingDevice[]>()
  const [selected, setSelected] = useState<ParkingDevice>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [deviceName, setDeviceName] = useState('')
  const [deviceGate, setDeviceGate] = useState<'entry' | 'exit' | 'both'>('both')
  const [inviteLink, setInviteLink] = useState('')
  const [inviteName, setInviteName] = useState('')

  useEffect(() => {
    let active = true
    void callParking<ParkingDevice[]>('listDevices').then(response => {
      if (active) { setDevices(response.result); setError('') }
    }).catch((failure: Error) => { if (active) setError(failure.message) })
    return () => { active = false }
  }, [refresh])

  async function deactivate(device: ParkingDevice) {
    setBusy(true)
    try {
      await callParking('deactivateDevice', [device.id])
      setDevices(current => current?.map(item => item.id === device.id ? { ...item, enabled: false, pending: false } : item))
      setSelected(undefined)
      toast(`${device.label} deactivated`)
    } catch (failure) { toast((failure as Error).message, true) }
    finally { setBusy(false) }
  }

  async function createDeviceLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !deviceName.trim()) return
    setBusy(true)
    setInviteLink('')
    try {
      const { result } = await callParking<{ code: string }>('issuePosDeviceLink', [deviceName.trim(), deviceGate])
      setInviteLink(location.href.split('#')[0] + '#/pos/' + result.code)
      setInviteName(deviceName.trim())
      setDeviceName('')
      setRefresh(current => current + 1)
    } catch (failure) { toast((failure as Error).message, true) }
    finally { setBusy(false) }
  }

  return <section className="card stack" aria-labelledby="devices-title">
    <h2 id="devices-title">POS machines</h2>
    <p className="muted small">Add each POS once. Then, on that POS, open PARKER and tap <b>Scan setup QR</b> (or open the link on it). Its offline tickets and any problems show under this name.</p>
    <form className="stack" onSubmit={event => void createDeviceLink(event)}>
      <label className="setf"><span className="lbl">POS name</span>
        <input className="field small-field" maxLength={80} value={deviceName} onChange={event => setDeviceName(event.target.value)} placeholder="e.g. Gate 1 Entry" required />
      </label>
      <label className="setf"><span className="lbl">This POS works at</span>
        <select className="field small-field" value={deviceGate} onChange={event => setDeviceGate(event.target.value as 'entry' | 'exit' | 'both')}>
          <option value="both">Entry and Exit</option><option value="entry">Entry only</option><option value="exit">Exit only</option>
        </select>
      </label>
      <button className="btn btn-primary" disabled={busy || !deviceName.trim()}>Add POS and show setup QR</button>
    </form>
    {inviteLink && <div className="banner banner-info pos-invite" role="status"><div className="stack">
      <b>Setup QR for {inviteName}</b>
      <p className="small">On that POS: open PARKER → <b>Scan setup QR</b> and point it here. This QR is private: it gives gate access until you remove the POS below.</p>
      <div className="pos-qr"><QR text={inviteLink} size={220} /></div>
      <button className="btn btn-ghost" onClick={() => void navigator.clipboard.writeText(inviteLink).then(() => toast('POS link copied'), () => toast('Could not copy the POS link', true))}>Copy setup link instead</button>
      <button className="btn btn-ghost" onClick={() => setInviteLink('')}>Done</button>
    </div></div>}
    {error ? <div role="alert"><p>{error}</p><button className="btn btn-ghost fit" onClick={() => setRefresh(n => n + 1)}>Retry</button></div>
      : !devices ? <p role="status">Loading devices…</p>
      : devices.length === 0 ? <p>No devices have been registered.</p>
      : <ul className="device-list">{devices.map(device => <li key={device.id}>
        <div><b>{device.label}</b><div className="muted small">{device.role === 'owner' ? 'Owner' : device.role === 'both' ? 'Entry and exit' : device.role === 'entry' ? 'Entry gate' : 'Exit gate'}{device.current ? ' · This browser' : ''}</div></div>
        <Pill tone={device.enabled ? 'ok' : 'warn'}>{device.enabled ? 'Active' : device.pending ? 'Pending setup' : 'Inactive'}</Pill>
        {(device.enabled || device.pending) && device.role !== 'owner' && <button className="btn btn-ghost fit" disabled={busy} onClick={() => setSelected(device)}>{device.pending ? 'Cancel link' : 'Remove POS'}</button>}
      </li>)}</ul>}
    {selected && <div className="banner banner-warn" role="group" aria-label="Confirm deactivation">
      <div className="stack">
        <p>Deactivate <b>{selected.label}</b>? This device will lose gate access.</p>
        <div className="row2">
          <button className="btn btn-ghost" disabled={busy} onClick={() => setSelected(undefined)}>Keep active</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void deactivate(selected)}>{busy ? 'Deactivating…' : 'Deactivate device'}</button>
        </div>
      </div>
    </div>}
  </section>
}

type PosAccount = {
  id: string
  label: string
  mobile: string
  role: 'entry' | 'exit' | 'both'
  enabled: boolean
  pending: boolean
}

function AccountsTab({ toast }: { toast: (message: string, bad?: boolean) => void }) {
  const [accounts, setAccounts] = useState<PosAccount[]>()
  const [showForm, setShowForm] = useState(false)
  const [label, setLabel] = useState('')
  const [mobile, setMobile] = useState('')
  const [gate, setGate] = useState<PosAccount['role']>('entry')
  const [invite, setInvite] = useState<{ code: string; expiresAt: string; mobile: string }>()
  const [selected, setSelected] = useState<PosAccount>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let current = true
    void callParking<PosAccount[]>('listAccounts').then(response => {
      if (current) { setAccounts(response.result); setError('') }
    }).catch((failure: Error) => { if (current) setError(failure.message) })
    return () => { current = false }
  }, [refresh])

  function openForm(account?: PosAccount) {
    setShowForm(true)
    setLabel(account?.label ?? '')
    setMobile(account?.mobile ?? '')
    setGate(account?.role ?? 'entry')
    setInvite(undefined)
  }

  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const number = indianMobile(mobile)
      const response = await callParking<{ code: string; expiresAt: string }>('issuePosCode', [number, gate, label.trim()])
      setInvite({ ...response.result, mobile: number })
      toast('POS setup code generated')
      setShowForm(false)
      setRefresh(n => n + 1)
    } catch (failure) { toast((failure as Error).message, true) }
    finally { setBusy(false) }
  }

  async function deactivate(account: PosAccount) {
    setBusy(true)
    try {
      await callParking(account.pending ? 'cancelPosSetup' : 'disablePosAccount', [account.id])
      setAccounts(current => current?.filter(item => !(item.id === account.id && account.pending)).map(item => item.id === account.id ? { ...item, enabled: false } : item))
      setSelected(undefined)
      toast(account.pending ? 'Setup code cancelled' : `${account.label} deactivated`)
    } catch (failure) { toast((failure as Error).message, true) }
    finally { setBusy(false) }
  }

  return <section className="card stack" aria-labelledby="pos-accounts-title">
    <h2 id="pos-accounts-title">POS accounts</h2>
    <button className="btn btn-primary fit" disabled={busy} onClick={() => openForm()}>Create POS account</button>
    {showForm && <form className="stack account-form" onSubmit={create}>
      <h3>New POS account</h3>
      <label className="setf"><span className="lbl">Operator or gate name</span>
        <input className="field small-field" value={label} onChange={event => setLabel(event.target.value)} maxLength={80} required />
      </label>
      <label className="setf"><span className="lbl">Mobile number</span>
        <input className="field small-field" type="tel" autoComplete="off" value={mobile} onChange={event => setMobile(event.target.value)} required />
      </label>
      <label className="setf"><span className="lbl">Gate access</span>
        <select className="field small-field" value={gate} onChange={event => setGate(event.target.value as PosAccount['role'])}>
          <option value="entry">Entry only</option><option value="exit">Exit only</option><option value="both">Entry + Exit</option>
        </select>
      </label>
      <div className="row2"><button className="btn btn-ghost" type="button" onClick={() => setShowForm(false)} disabled={busy}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Generate setup code'}</button></div>
    </form>}
    {invite && <div className="stack account-form">
      <h3>Setup code for {invite.mobile}</h3>
      <p className="muted small">The operator can enter this code under <b>Gate POS → Forgot password</b> to choose a PIN. It works once and expires at {fmtTime(Date.parse(invite.expiresAt))} IST.</p>
      <code className="owner-code">{invite.code.match(/.{4}/g)?.join('-')}</code>
      <div className="row2">
        <button className="btn btn-primary" onClick={() => void navigator.clipboard.writeText(invite.code).then(() => toast('Setup code copied'), () => toast('Could not copy the setup code', true))}>Copy setup code</button>
        <button className="btn btn-ghost" onClick={() => setInvite(undefined)}>Done</button>
      </div>
    </div>}
    {error ? <div role="alert"><p>{error}</p><button className="btn btn-ghost fit" onClick={() => setRefresh(n => n + 1)}>Retry</button></div>
      : !accounts ? <p role="status">Loading POS accounts…</p>
      : accounts.length === 0 ? <p className="muted small">No POS accounts yet.</p>
      : <ul className="device-list">{accounts.map(account => <li key={account.id}>
        <div><b>{account.label}</b><div className="muted small">{account.mobile} · {account.role === 'both' ? 'Entry + Exit' : account.role === 'entry' ? 'Entry gate' : 'Exit gate'}</div></div>
        <Pill tone={account.enabled ? 'ok' : 'warn'}>{account.pending ? 'Pending setup' : account.enabled ? 'Active' : 'Inactive'}</Pill>
        {(account.enabled || account.pending) && <>
          <button className="btn btn-ghost fit" disabled={busy} onClick={() => openForm(account)}>New setup code</button>
          <button className="btn btn-ghost fit" disabled={busy} onClick={() => setSelected(account)}>{account.pending ? 'Cancel code' : 'Deactivate'}</button>
        </>}
      </li>)}</ul>}
    {selected && <div className="banner banner-warn" role="group" aria-label="Confirm account deactivation"><div className="stack">
      <p>{selected.pending ? 'Cancel the setup code for' : 'Deactivate'} <b>{selected.label}</b>?</p>
      <div className="row2">
        <button className="btn btn-ghost" disabled={busy} onClick={() => setSelected(undefined)}>Keep active</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void deactivate(selected)}>{busy ? 'Saving…' : selected.pending ? 'Cancel setup code' : 'Deactivate account'}</button>
      </div>
    </div></div>}
  </section>
}

function OwnerAccessTab({ toast }: { toast: (message: string, bad?: boolean) => void }) {
  const [mobile, setMobile] = useState('')
  const [selected, setSelected] = useState('')
  const [invite, setInvite] = useState<{ code: string; expiresAt: string }>()
  const [busy, setBusy] = useState(false)

  async function generate(event: FormEvent) {
    event.preventDefault()
    if (!selected) {
      try { setSelected(indianMobile(mobile)); setInvite(undefined) }
      catch (failure) { toast((failure as Error).message, true) }
      return
    }
    setBusy(true)
    try {
      const response = await callParking<{ code: string; expiresAt: string }>('issueOwnerCode', [selected])
      setInvite(response.result)
      setSelected('')
    } catch (failure) { toast((failure as Error).message, true) }
    finally { setBusy(false) }
  }

  return <section className="card stack" aria-labelledby="owner-access-title">
    <h2 id="owner-access-title">Owner access</h2>
    <p className="muted small">Generate a code so a trusted person can set or reset an Owner password for their mobile number.</p>
    <form className="stack" onSubmit={generate}>
      <label className="setf"><span className="lbl">Owner mobile number</span>
        <input className="field small-field" type="tel" value={mobile} autoComplete="off" required disabled={busy}
          onChange={event => { setMobile(event.target.value); setSelected(''); setInvite(undefined) }} />
      </label>
      {selected && <div className="banner banner-warn"><div>Anyone with this code and <b>{selected}</b> can set the password for full Owner access. Share the code privately.</div></div>}
      <div className="row2">
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Generating…' : selected ? 'Confirm and generate code' : 'Generate recovery code'}</button>
        {selected && <button className="btn btn-ghost" type="button" onClick={() => setSelected('')} disabled={busy}>Cancel</button>}
      </div>
    </form>
    {invite && <div className="stack account-form">
      <p>Enter this one-time code under <b>Owner dashboard → Forgot password</b>. It expires at {fmtTime(Date.parse(invite.expiresAt))} IST.</p>
      <code className="owner-code">{invite.code}</code>
      <button className="btn btn-ghost fit" onClick={() => void navigator.clipboard.writeText(invite.code).then(() => toast('Recovery code copied'), () => toast('Could not copy the recovery code', true))}>Copy code</button>
    </div>}
  </section>
}

/** Owner switch: gates open to any device with the link, or only to approved POS machines. */
function GateLockCard({ db, toast }: { db: DB; toast: (message: string, bad?: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const locked = Boolean(db.gateLock)
  const set = async (value: boolean) => {
    setBusy(true)
    try { await callParking('setGateLock', [value]); toast(value ? 'Gates locked to approved POS machines' : 'Gates open to any device'); setConfirm(false) }
    catch (failure) { toast((failure as Error).message, true) } finally { setBusy(false) }
  }
  return <section className="card stack gate-lock">
    <div className="bill-head"><h2><Ico n="key" /> Gate lock</h2><Pill tone={locked ? 'ok' : 'warn'}>{locked ? 'On · approved POS only' : 'Off · open to anyone with the link'}</Pill></div>
    <p className="muted small">{locked
      ? 'Only the POS machines listed below can use Entry and Exit. A new POS must scan its setup QR first.'
      : 'Any phone that opens the website can use Entry and Exit. Add your POS machines below and set each one up, then turn the lock on.'}</p>
    {!confirm
      ? <button className={'btn ' + (locked ? 'btn-ghost' : 'btn-primary')} disabled={busy} onClick={() => locked ? void set(false) : setConfirm(true)}>{locked ? 'Turn lock off' : 'Turn lock on'}</button>
      : <div className="banner banner-warn"><div className="stack">
        <p>Any POS that has <b>not</b> scanned its setup QR will stop working at the gate until it does. Make sure every POS is set up (shown as Active below).</p>
        <div className="row2"><button className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(false)}>Not yet</button><button className="btn btn-primary" disabled={busy} onClick={() => void set(true)}>{busy ? 'Locking…' : 'Lock gates'}</button></div>
      </div></div>}
  </section>
}
