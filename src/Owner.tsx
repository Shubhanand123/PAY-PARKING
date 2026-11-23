import { indianMobile } from './parking-auth'
import { apiEnabled, callParking } from './parking-api'
import { publishTariff, saveSettings } from './actions'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  activeTariff, billFor, charge, dur, fmtDT, fmtTime, istDay, istHour, prettyPlate, rupees,
  type AuditKind, type DB, type Rate, type Settings, type Staff, type Ticket,
} from './engine'
import { Ico, Pill, useNow } from './ui'
import { Slip, StatusPill } from './Gate'
import { saveStart, saveEnd } from './done'

type Tab = 'overview' | 'tickets' | 'audit' | 'rates' | 'settings' | 'devices'

export function Owner({ db, me, toast }: { db: DB; me: Staff; toast: (m: string, bad?: boolean) => void }) {
  const [tab, setTab] = useState<Tab>('overview')
  const tabs: [Tab, string, string][] = [['overview', 'Overview', 'chart'], ['tickets', 'Tickets', 'list'], ['audit', 'Master audit', 'search'], ['rates', 'Rates', 'rupee'], ['settings', 'Settings', 'gear']]
  if (apiEnabled) tabs.push(['devices', 'Devices', 'gear'])
  return (
    <div className="owner">
      <nav className="tabs" aria-label="Owner sections">
        {tabs.map(([k, l, i]) => <button key={k} className={'tab' + (tab === k ? ' on' : '')} onClick={() => setTab(k)} aria-current={tab === k}><Ico n={i} size={18} />{l}</button>)}
      </nav>
      <div className="owner-panel">
      {tab === 'overview' && <Overview db={db} />}
      {tab === 'tickets' && <Tickets db={db} />}
      {tab === 'audit' && <AuditLog db={db} />}
      {tab === 'rates' && <Rates db={db} me={me} toast={toast} />}
      {tab === 'devices' && <div className="stack"><OwnerAccessTab toast={toast} /><AccountsTab toast={toast} /><DevicesTab toast={toast} /></div>}
      {tab === 'settings' && <SettingsTab db={db} me={me} toast={toast} />}
      </div>
    </div>
  )
}

// ---------- overview ----------
function Overview({ db }: { db: DB }) {
  const now = useNow(30000)
  const today = istDay(now)
  const s = useMemo(() => {
    const inside = db.tickets.filter(t => t.status === 'inside' || t.status === 'paid')
    const tIn = db.tickets.filter(t => istDay(t.entryAt) === today)
    const tOut = db.tickets.filter(t => t.status === 'exited' && istDay(t.exitAt!) === today)
    const cash = db.payments.filter(p => istDay(p.at) === today).reduce((a, p) => a + p.amountPaise, 0)
    const cancels = db.tickets.filter(t => t.status === 'cancelled' && istDay(t.cancelledAt!) === today).length
    const avg = tOut.length ? tOut.reduce((a, t) => a + (t.exitAt! - t.entryAt), 0) / tOut.length : 0
    const lostSlip = db.audit.filter(a => a.kind === 'lookup_plate' && istDay(a.at) === today).length
    const reprints = db.audit.filter(a => a.kind === 'reprint' && istDay(a.at) === today).length
    const days = Array.from({ length: 7 }, (_, i) => istDay(now - (6 - i) * 864e5))
    const daily = days.map(d => ({ d, v: db.payments.filter(p => istDay(p.at) === d).reduce((a, p) => a + p.amountPaise, 0), n: db.tickets.filter(t => istDay(t.entryAt) === d).length }))
    const hours = Array.from({ length: 24 }, (_, h) => ({ h, i: tIn.filter(t => istHour(t.entryAt) === h).length, o: tOut.filter(t => istHour(t.exitAt!) === h).length }))
    const byCat = db.categories.map(c => ({ name: c.name, icon: c.icon, n: inside.filter(t => t.category === c.id).length, rev: db.payments.filter(p => istDay(p.at) === today && db.tickets.find(t => t.id === p.ticketId)?.category === c.id).reduce((a, p) => a + p.amountPaise, 0) }))
    const longStay = inside.filter(t => now - t.entryAt > 12 * 36e5)
    const openRunning = inside.reduce((a, t) => a + billFor(db, t, now).duePaise, 0)
    return { inside, tIn, tOut, cash, cancels, avg, lostSlip, reprints, daily, hours, byCat, longStay, openRunning }
  }, [db, now, today])
  const cap = db.settings.capacity
  const occ = cap ? s.inside.length / cap : 0

  return (
    <div className="stack">
      <FlowStrip />
      <div className="kpis">
        <Kpi icon="p" label="Inside now" value={String(s.inside.length)} sub={cap ? `of ${cap} spaces` : ''} tone="info" />
        <Kpi icon="cash" label="Cash today" value={rupees(s.cash)} sub={`${s.tOut.length} exits`} tone="ok" />
        <Kpi icon="car" label="Entries today" value={String(s.tIn.length)} sub={`${s.tOut.length} left`} />
        <Kpi icon="clock" label="Average stay" value={s.avg ? dur(s.avg) : '–'} sub="vehicles that left today" />
        <Kpi icon="rupee" label="Due from cars inside" value={rupees(s.openRunning)} sub="if all left now" />
        <Kpi icon="x" label="Cancelled today" value={String(s.cancels)} sub={`${s.reprints} reprints · ${s.lostSlip} plate lookups`} tone={s.cancels > 3 ? 'warn' : undefined} />
      </div>
      <div className="grid2">
        <div className="card">
          <h2>Occupancy</h2>
          <Gauge v={occ} label={`${Math.round(occ * 100)}%`} sub={`${s.inside.length} of ${cap}`} />
          <div className="legend">{s.byCat.filter(c => c.n).map(c => <span key={c.name}><Ico n={c.icon} size={16} /> {c.name} <b>{c.n}</b></span>)}</div>
        </div>
        <div className="card">
          <h2>Collections, last 7 days</h2>
          <Bars data={s.daily.map(d => ({ label: new Date(d.d + 'T12:00:00+05:30').toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' }), v: d.v / 100, tip: `${rupees(d.v)} · ${d.n} vehicles` }))} fmt={v => '₹' + Math.round(v).toLocaleString('en-IN')} />
        </div>
      </div>
      <div className="card">
        <h2>Today by hour</h2>
        <p className="muted small">Entries and exits each hour (IST). Busy hours tell you when to put extra staff at the gate.</p>
        <Lines hours={s.hours} />
      </div>
      <div className="grid2">
        <div className="card">
          <h2>Cash today by vehicle type</h2>
          <Donut parts={s.byCat.map((c, i) => ({ label: c.name, v: c.rev, color: `var(--color-chart-${i + 1})` }))} />
        </div>
        <div className="card">
          <h2>Needs a look</h2>
          {s.longStay.length === 0 && s.cancels <= 3 && <Empty text="Nothing unusual right now." />}
          {s.longStay.map(t => <div key={t.id} className="listrow static"><Ico n="clock" /><b>{prettyPlate(t.plate)}</b><span>inside {dur(now - t.entryAt)}</span><Pill tone="warn">Long stay</Pill></div>)}
          {s.cancels > 3 && <div className="listrow static"><Ico n="warn" /><b>{s.cancels} cancels today</b><span>Check the master audit</span></div>}
        </div>
      </div>
    </div>
  )
}

function FlowStrip() {
  const steps: [string, string, string][] = [['scan', 'Entry', 'Scan plate, pick type'], ['print', 'Slip', 'Saved, then printed with QR'], ['clock', 'Parked', 'Fee grows by the rates'], ['qr', 'Exit', 'Scan QR or plate'], ['cash', 'Pay', 'Cash, bill worked out'], ['out', 'Leave', 'Exit and receipt']]
  return (
    <div className="flow" aria-label="How a vehicle moves through the system">
      <svg className="flow-road" viewBox="0 0 600 20" preserveAspectRatio="none" aria-hidden="true"><path d="M0 10H600" strokeDasharray="10 10" /></svg>
      {steps.map(([i, t, d], k) => <div key={k} className="flow-step"><span className="flow-ico"><Ico n={i} size={22} /></span><b>{t}</b><small>{d}</small></div>)}
    </div>
  )
}

function Kpi({ icon, label, value, sub, tone }: { icon: string; label: string; value: string; sub?: string; tone?: 'ok' | 'info' | 'warn' }) {
  return <div className={'kpi' + (tone ? ' kpi-' + tone : '')}><span className="kpi-ico"><Ico n={icon} /></span><div className="kpi-l">{label}</div><div className="kpi-v num">{value}</div>{sub && <div className="kpi-s">{sub}</div>}</div>
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
  if (!tot) return <Empty text="No cash collected yet today." />
  let acc = 0
  const R = 52, C = 2 * Math.PI * R
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 140 140" className="donut" role="img" aria-label="Cash by vehicle type">
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
function Tickets({ db }: { db: DB }) {
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
        <Slip db={db} t={sel} receipt={sel.status === 'exited'} />
      </div>}
    </div>
  )
}

function csv(db: DB) {
  const today = istDay(Date.now())
  const rows = [['ticket', 'plate', 'type', 'entry_ist', 'exit_ist', 'status', 'total_rupees', 'cash_rupees', 'entry_by', 'exit_by', 'tariff_version']]
  db.tickets.filter(t => istDay(t.entryAt) === today || (t.exitAt && istDay(t.exitAt) === today)).forEach(t => rows.push([
    t.id, prettyPlate(t.plate), db.categories.find(c => c.id === t.category)?.name ?? '', fmtDT(t.entryAt), t.exitAt ? fmtDT(t.exitAt) : '', t.status,
    t.totalPaise != null ? (t.totalPaise / 100).toFixed(2) : '', (db.payments.filter(p => p.ticketId === t.id).reduce((a, p) => a + p.amountPaise, 0) / 100).toFixed(2),
    t.entryBy, t.exitBy ?? '', String(db.tariffs.find(x => x.id === t.tariffId)?.version ?? ''),
  ]))
  const blob = new Blob([rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `parking-${today}.csv`; a.click()
}

// ---------- master audit ----------
const KIND: Record<AuditKind, [string, 'ok' | 'warn' | 'bad' | 'info' | 'mute']> = {
  entry: ['Entry', 'info'], print: ['Print', 'mute'], reprint: ['Reprint', 'warn'], lookup_plate: ['Plate lookup', 'warn'], lookup_qr: ['Opened', 'mute'],
  plate_fix: ['Plate fixed', 'warn'], payment: ['Cash', 'ok'], exit: ['Exit', 'ok'], cancel: ['Cancel', 'bad'], tariff: ['Rates', 'warn'],
  settings: ['Settings', 'warn'], duplicate_blocked: ['Duplicate blocked', 'warn'], login: ['Login', 'mute'],
}
function AuditRow({ a }: { a: DB['audit'][number] }) {
  const [l, tone] = KIND[a.kind]
  return <div className="arow"><span className="a-t num">{fmtDT(a.at)}</span><Pill tone={tone}>{l}</Pill><span className="a-x">{a.text}</span><span className="a-by muted">{a.by}{a.ticketId ? ` · ${a.ticketId}` : ''}</span></div>
}
function AuditLog({ db }: { db: DB }) {
  const [kind, setKind] = useState<'all' | 'money' | 'risk' | AuditKind>('risk')
  const [who, setWho] = useState('all')
  const [q, setQ] = useState('')
  const risk: AuditKind[] = ['cancel', 'reprint', 'lookup_plate', 'tariff', 'settings', 'duplicate_blocked', 'plate_fix']
  const list = db.audit.filter(a => (kind === 'all' || (kind === 'money' ? ['payment', 'exit'].includes(a.kind) : kind === 'risk' ? risk.includes(a.kind) : a.kind === kind))
    && (who === 'all' || a.by === who) && (!q || (a.text + a.ticketId).toLowerCase().includes(q.toLowerCase()))).slice().reverse()
  const today = istDay(Date.now())
  const per = db.staff.map(s => ({ s, cash: db.payments.filter(p => p.by === s.name && istDay(p.at) === today).reduce((a, p) => a + p.amountPaise, 0), cancels: db.audit.filter(a => a.by === s.name && a.kind === 'cancel' && istDay(a.at) === today).length, reprints: db.audit.filter(a => a.by === s.name && a.kind === 'reprint' && istDay(a.at) === today).length }))
  return (
    <div className="stack">
      <div className="card">
        <h2>Today by staff member</h2>
        <p className="muted small">Every action on every POS is recorded here. Nobody can edit or delete these records.</p>
        <table className="tbl"><thead><tr><th>Staff</th><th className="r">Cash taken</th><th className="r">Cancels</th><th className="r">Reprints</th></tr></thead>
          <tbody>{per.map(p => <tr key={p.s.id}><td>{p.s.name}</td><td className="r num">{rupees(p.cash)}</td><td className="r num">{p.cancels}</td><td className="r num">{p.reprints}</td></tr>)}</tbody></table>
      </div>
      <div className="card toolbar">
        <select className="field small-field" value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
          <option value="risk">Things to check (cancels, reprints, lookups, rate changes)</option><option value="money">Money (cash, exits)</option><option value="all">Everything</option>
          {Object.entries(KIND).map(([k, [l]]) => <option key={k} value={k}>Only: {l}</option>)}
        </select>
        <select className="field small-field" value={who} onChange={e => setWho(e.target.value)}><option value="all">All staff</option>{db.staff.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}</select>
        <input className="field small-field" placeholder="Search text or ticket" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div className="card">{list.slice(0, 300).map(a => <AuditRow key={a.id} a={a} />)}{!list.length && <Empty text="No matching records." />}</div>
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
        {f('operator', 'Company name')}{f('siteName', 'Site name')}{f('address', 'Address')}{f('phone', 'Phone')}{f('capacity', 'Total spaces', 'number')}
      </div>
      <button className="btn btn-primary" disabled={!changed || saving} onClick={async () => {
        setSaving(true)
        saveStart()
        try {
          await saveSettings(me.id, s)
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
  role: 'owner' | 'entry' | 'exit'
  enabled: boolean
  current: boolean
}

function DevicesTab({ toast }: { toast: (message: string, bad?: boolean) => void }) {
  const [devices, setDevices] = useState<ParkingDevice[]>()
  const [selected, setSelected] = useState<ParkingDevice>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)

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
      setDevices(current => current?.map(item => item.id === device.id ? { ...item, enabled: false } : item))
      setSelected(undefined)
      toast(`${device.label} deactivated`)
    } catch (failure) { toast((failure as Error).message, true) }
    finally { setBusy(false) }
  }

  return <section className="card stack" aria-labelledby="devices-title">
    <h2 id="devices-title">Parking devices</h2>
    <p className="muted small">Deactivate a lost or unused gate device here. Its current setup code will stop working.</p>
    {error ? <div role="alert"><p>{error}</p><button className="btn btn-ghost fit" onClick={() => setRefresh(n => n + 1)}>Retry</button></div>
      : !devices ? <p role="status">Loading devices…</p>
      : devices.length === 0 ? <p>No devices have been registered.</p>
      : <ul className="device-list">{devices.map(device => <li key={device.id}>
        <div><b>{device.label}</b><div className="muted small">{device.role === 'owner' ? 'Owner' : device.role === 'entry' ? 'Entry gate' : 'Exit gate'}{device.current ? ' · This browser' : ''}</div></div>
        <Pill tone={device.enabled ? 'ok' : 'warn'}>{device.enabled ? 'Active' : 'Inactive'}</Pill>
        {device.enabled && device.role !== 'owner' && <button className="btn btn-ghost fit" disabled={busy} onClick={() => setSelected(device)}>Deactivate</button>}
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
