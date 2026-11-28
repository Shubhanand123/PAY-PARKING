// Public pages: privacy policy (DPDP Act 2023), parking terms, and the report check (#/verify/CODE).
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { fmtDT } from './engine'
import { RETENTION_DAYS } from './complaints'
import { readCheckCode, type VerifiedReport } from './reports'
import { publicInfo, verifyReport, type PublicInfo } from './care-api'
import './care.css'

export function PublicPage({ route }: { route: string }) {
  const [info, setInfo] = useState<PublicInfo>()
  const [error, setError] = useState('')
  useEffect(() => { publicInfo().then(setInfo).catch(e => setError((e as Error).message)) }, [])
  const page = route === 'privacy' ? 'privacy' : route === 'terms' ? 'terms' : 'verify'
  return (
    <div className="screen legal">
      <header className="cp-head"><img className="parker-logo" src="parker-logo.png" alt="PARKER" /><div><b>{info?.operator ?? 'Parking'}</b><small>{info?.siteName}</small></div></header>
      <main className="content legal-main">
        {error && <p className="msg bad" role="alert">{error}</p>}
        {page === 'privacy' && <Privacy s={info} />}
        {page === 'terms' && <Terms s={info} />}
        {page === 'verify' && <Verify initial={route.slice('verify/'.length)} />}
        <nav className="legal-nav"><a href="#/privacy">Privacy policy</a> · <a href="#/terms">Parking terms</a> · <a href="#/verify">Check a report</a></nav>
      </main>
    </div>
  )
}

const missing = (v: string | undefined, what: string) => v?.trim() ? v : <i className="muted">[{what}: not added yet]</i>
function Officer({ s }: { s?: PublicInfo }) {
  return <p className="legal-box">
    <b>Grievance officer:</b> {missing(s?.grievanceName, 'name')}<br />
    Phone: {s?.grievancePhone ? <a href={'tel:' + s.grievancePhone.replace(/[^\d+]/g, '')}>{s.grievancePhone}</a> : missing(undefined, 'phone')}<br />
    Email: {s?.grievanceEmail ? <a href={'mailto:' + s.grievanceEmail}>{s.grievanceEmail}</a> : missing(undefined, 'email')}<br />
    Address: {missing(s?.address, 'address')}
  </p>
}
function Section({ h, children }: { h: string; children: ReactNode }) { return <section><h2>{h}</h2>{children}</section> }

function Privacy({ s }: { s?: PublicInfo }) {
  const who = s?.operator ?? 'the parking operator'
  return <article className="card legal-doc">
    <h1>Privacy policy</h1>
    <p className="muted small">Under the Digital Personal Data Protection Act, 2023. {who} (“we”) runs this parking site{s?.siteName ? ` (${s.siteName})` : ''} and decides how the data below is used.</p>
    <Section h="What we collect and why">
      <ul>
        <li><b>Vehicle number, vehicle type, entry and exit time, gate and ticket number</b>: to issue your ticket, work out the charge and let you leave. Kept as part of our business and tax records.</li>
        <li><b>Payments</b>: amount, time, receipt number, and for online payments the Razorpay payment id. Card and UPI details are handled by Razorpay; we never see or keep them.</li>
        <li><b>Number-plate picture</b> taken by the gate camera when you come in: to read the vehicle number and to improve the reader. Deleted after 30 days.</li>
        <li><b>Complaints</b>: your name, mobile number, message and any photos you add. Used only to look into and answer your complaint (we may call or WhatsApp you on that number). Deleted, with the photos, {RETENTION_DAYS} days after the complaint is closed.</li>
        <li><b>Rating</b> (smiley) you give on the ticket page. It is not linked to your name.</li>
      </ul>
    </Section>
    <Section h="Who sees it">
      <p>Only {who} and the staff who run the gates. The gate machines do not receive complaint details. Data is stored with our service providers (Supabase for the records, Razorpay for online payments, Cloudflare for this website) under their security terms. We do not sell or share your data for advertising.</p>
    </Section>
    <Section h="Your rights">
      <p>You can ask us to show the data we hold about you, correct it, or delete it when it is no longer needed for the purpose or required by law (for example, tax records of payments must be kept). You can withdraw your consent for a complaint at any time; we will then stop using it and delete it. You can also nominate someone to act for you. Write to the grievance officer below; we reply within 7 days. If you are not satisfied, you may complain to the Data Protection Board of India.</p>
    </Section>
    <Section h="Contact"><Officer s={s} /></Section>
    <p className="tiny muted">Last updated 28 November 2026.</p>
  </article>
}

function Terms({ s }: { s?: PublicInfo }) {
  const who = s?.operator ?? 'the parking operator'
  return <article className="card legal-doc">
    <h1>Parking terms</h1>
    <p className="muted small">By parking here you agree to these terms. {who}{s?.address ? `, ${s.address}` : ''}{s?.gstin ? ` · GSTIN ${s.gstin}` : ''}.</p>
    <Section h="Charges">
      <ul>
        <li>Charges are shown at the entrance and on your ticket page (scan the QR on your slip). The rates in force when you came in apply to your whole stay.</li>
        <li>Leaving within the free grace period shown on your ticket costs nothing. After the first hours, every started hour is charged. The most you pay per 24 hours is shown on your ticket.</li>
        <li>If you paid before parking, there is no refund for leaving early; extra time is charged at the exit.</li>
        <li>You can pay at the exit by cash or UPI, or on your phone from the ticket page. You get a receipt with a receipt number; prices include GST where applicable.</li>
      </ul>
    </Section>
    <Section h="Your ticket">
      <ul>
        <li>Keep your slip and show it at the exit. If you lose it, the attendant finds your ticket by vehicle number; no extra fee is charged.</li>
        <li>Only one ticket can be open for a vehicle at a time.</li>
      </ul>
    </Section>
    <Section h="Care of your vehicle">
      <ul>
        <li>Lock your vehicle and do not leave valuables inside. Follow the attendant's directions and the speed limit inside the site.</li>
        <li>If you notice damage or something missing, tell the attendant before you leave and raise a complaint from your ticket page with photos, so we can check at once.</li>
      </ul>
    </Section>
    <Section h="Complaints">
      <p>Scan the QR on your slip or receipt and tap <b>Raise a complaint</b>. You get a complaint number (SKC-C-…) and our reply on the same page. You can also contact the grievance officer:</p>
      <Officer s={s} />
    </Section>
    <p className="tiny muted">Last updated 28 November 2026.</p>
  </article>
}

function Verify({ initial }: { initial: string }) {
  const [code, setCode] = useState(decodeURIComponent(initial))
  const [res, setRes] = useState<VerifiedReport | null>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const check = async (value: string) => {
    if (!readCheckCode(value)) { setError('A check code has 8 letters and digits, like K7Q2-M9XD.'); setRes(undefined); return }
    setBusy(true); setError('')
    try { setRes((await verifyReport(value)) ?? null) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  useEffect(() => { if (initial) void check(decodeURIComponent(initial)) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (e: FormEvent) => { e.preventDefault(); void check(code) }
  const day = (d: string) => new Date(d + 'T12:00:00+05:30').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
  return <article className="card legal-doc">
    <h1>Check a report</h1>
    <p className="muted small">Every printed report has a check code at the bottom. Type it here to see that the report is genuine and that its totals match ours.</p>
    <form className="toolbar" onSubmit={submit}>
      <input className="field" value={code} onChange={e => setCode(e.target.value)} placeholder="e.g. K7Q2-M9XD" autoCapitalize="characters" aria-label="Check code" />
      <button className="btn btn-primary fit" disabled={busy}>{busy ? 'Checking…' : 'Check'}</button>
    </form>
    {error && <p className="msg bad" role="alert">{error}</p>}
    {res === null && <p className="msg bad" role="alert">No report has this check code. The report may not be genuine, or the code was typed wrong.</p>}
    {res && <div className="vf-ok">
      <b className="vf-tick">✓ Genuine report</b>
      <p><b>{res.title}</b> · {res.from === res.to ? day(res.from) : `${day(res.from)} to ${day(res.to)}`}</p>
      <p className="muted small">Issued by {res.operator}{res.siteName ? `, ${res.siteName}` : ''}{res.gstin ? ` (GSTIN ${res.gstin})` : ''} · printed {fmtDT(res.at)} by {res.by} · {res.rows} rows</p>
      <div className="rp-totals">{res.totals.map(([l, v]) => <div key={l}><small>{l}</small><b className="num">{v}</b></div>)}</div>
      <p className="tiny muted">Fingerprint {res.digest.slice(0, 16)}. These totals must match the printed report exactly.</p>
    </div>}
  </article>
}
