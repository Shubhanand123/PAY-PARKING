import { auth } from './parking-auth'
import { Login } from './Login'
import { apiEnabled, callParking, currentSnapshot, deviceKey, isOfflineError, openAccess, outbox, ParkingApiError, setDeviceKey, syncOutbox, type Snapshot } from './parking-api'
import { nativeApp } from './native'
import { fmtTime, type DB } from './engine'
import { useCallback, useEffect, useState } from 'react'
import { useDB, useNow, Ico, Toast } from './ui'
import { Entry, Exit, Customer } from './Gate'
import { PlateScanner } from './PlateScanner'
import { Owner } from './Owner'

type View = 'entry' | 'exit' | 'owner'
const route = () => location.hash.replace(/^#\/?/, '')
let pairing: { code: string; request: Promise<void> } | undefined

function openDirectPos(link: string) {
  if (pairing?.code === link) return pairing.request
  const [kind, code] = link.split('/')
  const request = (kind === 'pair-pos'
    ? callParking<{ key: string }>('pairPosDevice', [code], '').then(({ result }) => result.key)
    : callParking('posSnapshot', [], code).then(() => code)).then(async key => {
    await auth?.auth.signOut({ scope: 'local' })
    setDeviceKey(key)
  })
  pairing = { code: link, request }
  return request
}

const isPosLink = (value: string) => /^(?:pos|pair-pos)\//.test(value)

export default function App() {
  return !apiEnabled ? <LocalApp /> : openAccess ? <OpenApp /> : <ConnectedApp />
}

/** Gates need no sign-in. The Owner dashboard needs the Owner's mobile number and password. */
function OpenApp() {
  // Opens at once from the records saved on this POS; the server copy replaces it within a second.
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(() => { const s = currentSnapshot(); return s?.role === 'owner' ? undefined : s })
  const [customer, setCustomer] = useState<DB>()
  const [sessionId, setSessionId] = useState<string | null | undefined>(auth ? undefined : null)
  const [error, setError] = useState('')
  const [r, setR] = useState(route())
  useEffect(() => {
    const changed = () => setR(route())
    const updated = (event: Event) => setSnapshot((event as CustomEvent<Snapshot>).detail)
    addEventListener('hashchange', changed)
    addEventListener('parking-snapshot', updated)
    return () => { removeEventListener('hashchange', changed); removeEventListener('parking-snapshot', updated) }
  }, [])
  useEffect(() => {
    if (!auth) return
    const { data: { subscription } } = auth.auth.onAuthStateChange((_event, session) => setSessionId(session?.user.id ?? null))
    return () => subscription.unsubscribe()
  }, [])
  const [setupNeeded, setSetupNeeded] = useState(false)
  useEffect(() => {
    let active = true
    if (isPosLink(r)) {
      // Setup link or QR from the Owner dashboard: approve this POS, then open the gates.
      void openDirectPos(r).then(() => { if (active) { setSetupNeeded(false); setError(''); location.replace('#/entry') } })
        .catch((failure: Error) => { if (active) { setError(failure.message); location.replace('#/entry') } })
      return () => { active = false }
    }
    const refresh = async () => {
      try {
        if (r.startsWith('t/')) {
          const response = await callParking('customer', [r.slice(2)], '')
          if (active) setCustomer(response.db)
        } else { await syncOutbox(); await callParking('snapshot') }
        if (active) { setError(''); setSetupNeeded(false) }
      } catch (failure) {
        if (!active) return
        // An expired or replaced Owner session: drop it and fall back to the open gate view.
        if (sessionId && failure instanceof ParkingApiError && failure.status === 401) await auth?.auth.signOut({ scope: 'local' })
        if (failure instanceof ParkingApiError && failure.status === 403 && /not set up/i.test(failure.message)) { setSetupNeeded(true); setSnapshot(undefined) }
        if (failure instanceof ParkingApiError && failure.status === 401 && deviceKey()) { setDeviceKey(''); setSetupNeeded(true) } // POS removed in the dashboard
        setError(isOfflineError(failure) ? 'offline' : (failure as Error).message)
      }
    }
    void refresh()
    const poll = setInterval(refresh, 5000)
    const back = () => void refresh()
    addEventListener('online', back)
    return () => { active = false; clearInterval(poll); removeEventListener('online', back) }
  }, [r, sessionId])

  async function activateOwner(key: string) {
    const response = await callParking('snapshot', [], key)
    if (response.snapshot?.role !== 'owner') throw new Error('Enter an Owner setup code.')
    setDeviceKey(key)
    setSnapshot(response.snapshot)
  }
  async function signOut() {
    setDeviceKey('')
    await auth?.auth.signOut({ scope: 'local' })
    setSnapshot(undefined)
    location.hash = '/entry'
  }

  if (r.startsWith('t/')) return customer ? <ParkingApp db={customer} /> : <main className="content"><p role="status">{error || 'Loading ticket…'}</p></main>
  const owner = snapshot?.role === 'owner'
  if (r === 'owner' && !nativeApp && !owner) {
    if (sessionId === undefined || (sessionId && !error)) return <main className="screen"><div className="content"><p role="status">Checking Owner sign-in…</p></div></main>
    return <Login onOwnerSetup={activateOwner} error={sessionId ? error : ''} />
  }
  if (isPosLink(r)) return <main className="screen"><div className="content"><p role="status">Setting up this POS…</p></div></main>
  if (setupNeeded && r !== 'owner') return <PosSetup error={error} />
  if (!snapshot) return <main className="screen"><div className="content"><p role={error ? 'alert' : 'status'}>{error === 'offline' ? 'No internet. Connect this POS once to load the parking records; after that it also works offline.' : error || 'Connecting to parking records…'}</p></div></main>
  return <><ParkingApp db={snapshot.db} role={snapshot.role === 'open' || snapshot.role === 'owner' ? undefined : snapshot.role} signOut={owner ? signOut : undefined} offline={error === 'offline'} />{error && error !== 'offline' && <div className="content"><p role="alert">{error}</p></div>}</>
}

function LocalApp() {
  return <ParkingApp db={useDB()} />
}

function ConnectedApp() {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [customer, setCustomer] = useState<DB>()
  const [sessionId, setSessionId] = useState<string | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [r, setR] = useState(route())

  useEffect(() => {
    const changed = () => setR(route())
    const updated = (event: Event) => setSnapshot((event as CustomEvent<Snapshot>).detail)
    addEventListener('hashchange', changed)
    addEventListener('parking-snapshot', updated)
    return () => { removeEventListener('hashchange', changed); removeEventListener('parking-snapshot', updated) }
  }, [])

  useEffect(() => {
    if (!auth) { setSessionId(null); return }
    const { data: { subscription } } = auth.auth.onAuthStateChange((_event, session) => {
      setSessionId(session?.user.id ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    let active = true
    setError('')
    setCustomer(undefined)
    if (isPosLink(r)) {
      void openDirectPos(r).then(() => {
        if (active) { setSnapshot(undefined); location.replace('#/entry') }
      }).catch((failure: Error) => { if (active) setError(failure.message) })
      return () => { active = false }
    }
    const refresh = async () => {
      try {
        if (r.startsWith('t/')) {
          const response = await callParking('customer', [r.slice(2)], '')
          if (active) setCustomer(response.db)
        } else if (sessionId || deviceKey()) {
          await callParking('snapshot')
        }
        if (active) setError('')
      } catch (failure) {
        if (!active) return
        if (!r.startsWith('t/') && failure instanceof ParkingApiError && (failure.status === 401 || failure.status === 403)) {
          setSnapshot(undefined)
          if (sessionId) await auth?.auth.signOut({ scope: 'local' })
          else setDeviceKey('')
        }
        setError(isOfflineError(failure) ? 'offline' : (failure as Error).message)
      }
    }
    void refresh()
    const poll = setInterval(refresh, 5000)
    const back = () => void refresh()
    addEventListener('online', back)
    return () => { active = false; clearInterval(poll); removeEventListener('online', back) }
  }, [r, sessionId])

  async function activateOwner(key: string) {
    const response = await callParking('snapshot', [], key)
    if (response.snapshot?.role !== 'owner') {
      setSnapshot(undefined)
      throw new Error('Enter an Owner setup code.')
    }
    setDeviceKey(key)
    setSnapshot(response.snapshot)
  }

  async function signOut() {
    if (!sessionId) setDeviceKey('')
    setSnapshot(undefined)
    setError('')
    await auth?.auth.signOut({ scope: 'local' })
    location.hash = snapshot?.role === 'owner' ? '/owner' : ''
  }

  if (r.startsWith('t/')) {
    return customer ? <ParkingApp db={customer} /> : <main className="content"><p role="status">{error || 'Loading ticket…'}</p></main>
  }
  if (isPosLink(r)) {
    return <main className="content"><p role={error ? 'alert' : 'status'}>{error || 'Opening POS…'}</p>{error && <a className="link" href="#/entry">Open parking app</a>}</main>
  }
  if (snapshot && (sessionId || deviceKey()) && (r !== 'owner' || snapshot.role === 'owner')) {
    return <><ParkingApp db={snapshot.db} role={snapshot.role} signOut={signOut} /><div className="content">
      {error && <p role="alert">{error} Reconnect before collecting cash.</p>}
    </div></>
  }
  if (r === 'owner' && snapshot && snapshot.role !== 'owner') return <Login onOwnerSetup={activateOwner} error={error} />
  if (sessionId === undefined || ((sessionId || deviceKey()) && !error)) {
    return <main className="screen"><div className="content"><p role="status">Connecting to parking records…</p></div></main>
  }
  if (r === 'owner') return <Login onOwnerSetup={activateOwner} error={error} />
  return <div className="screen">
    <header className="hero compact"><div className="hero-row"><span className="brand"><span className="brand-mark"><Ico n="p" /></span>PARKAR</span></div><h1>Gate POS</h1></header>
    <main className="content"><section className="card stack">
      <p>{error || 'Open your direct POS link on this machine to start.'}</p>
      <a className="link" href="#/owner">Owner dashboard</a>
    </section></main>
  </div>
}

function ParkingApp({ db, role: given, signOut, offline = false }: { db: DB; role?: Snapshot['role']; signOut?: () => void; offline?: boolean }) {
  const role = given === 'open' ? undefined : given
  const [r, setR] = useState(route())
  const [toast, setToast] = useState<{ m: string; bad?: boolean } | null>(null)
  const [flow, setFlow] = useState('') // slip, QR or receipt on screen: hide the Entry/Exit switch
  useEffect(() => { const f = () => setR(route()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  const say = useCallback((m: string, bad?: boolean) => setToast({ m, bad }), [])
  const done = useCallback(() => setToast(null), [])

  if (r.startsWith('t/')) return (
    <div className="screen">
      <header className="hero slim"><div className="glow g1" /><div className="hero-row"><div className="brand"><span className="brand-mark"><Ico n="p" /></span>{db.settings.siteName}</div></div><h1>Your parking ticket</h1></header>
      <main className="content"><Customer db={db} token={r.slice(2)} /></main>
    </div>
  )

  // The POS app is for the gates only: the Owner dashboard lives on the website, behind the Owner's sign-in.
  const requested: View = r === 'exit' ? 'exit' : r === 'owner' && !nativeApp ? 'owner' : 'entry'
  const view = role === 'both' ? (requested === 'exit' ? 'exit' : 'entry') : role ?? requested
  const routes: View[] = role === 'both' || nativeApp ? ['entry', 'exit'] : role ? [] : ['entry', 'exit', 'owner']
  const me = db.staff.find(s => s.id === (view === 'entry' ? 'ravi' : view === 'exit' ? 'sunil' : 'owner'))!
  const wide = view === 'owner'
  const gate = view !== 'owner'
  return (
    <div className={wide ? 'screen wide' : 'screen'}>
      {gate ? <GateHeader view={view} routes={routes} flow={flow} offline={offline} /> : <header className="hero">
        <div className="glow g1" /><div className="glow g2" />
        <div className="hero-row">
          <div className="brand"><span className="brand-logo"><img src="skc.png" alt="SKC" /></span>PARKAR</div>
          {signOut ? <button className="demo-tag signout" onClick={signOut}>Sign out</button> : <span className="demo-tag">{openAccess ? 'Open access · no sign-in' : 'Local mode · this browser'}</span>}
        </div>
        {routes.length > 0 && <nav className="switch" aria-label="Choose screen">
          {routes.map(v => <a key={v} href={'#/' + v} className={'sw-btn' + (view === v ? ' on' : '')} aria-current={view === v}>{v === 'entry' ? 'Entry gate' : v === 'exit' ? 'Exit gate' : 'Owner'}</a>)}
        </nav>}
        <h1>Owner dashboard</h1>
        <p>{db.settings.operator} · {db.settings.siteName}</p>
      </header>}
      <main className="content">
        {view === 'entry' && <Entry db={db} me={me} toast={say} onFlow={setFlow} />}
        {view === 'exit' && <Exit db={db} me={me} toast={say} onFlow={setFlow} />}
        {view === 'owner' && <Owner db={db} me={me} toast={say} />}
      </main>
      {toast && <Toast msg={toast.m} tone={toast.bad ? 'bad' : 'ok'} onDone={done} />}
    </div>
  )
}

/** H2 header for the gates: colour-coded Entry (blue) / Exit (orange) switch, clock and connection light.
 *  While a slip, a payment QR or a receipt is on screen the switch is replaced by a gate badge. */
function GateHeader({ view, routes, flow, offline }: { view: View; routes: View[]; flow: string; offline: boolean }) {
  const now = useNow(15000)
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    addEventListener('online', on); addEventListener('offline', off)
    return () => { removeEventListener('online', on); removeEventListener('offline', off) }
  }, [])
  const [waiting, setWaiting] = useState(() => apiEnabled ? outbox().length : 0)
  useEffect(() => { const f = (e: Event) => setWaiting((e as CustomEvent<number>).detail); addEventListener('parkar-outbox', f); return () => removeEventListener('parkar-outbox', f) }, [])
  const net = !online || offline
  const tabs = routes.filter(v => v !== 'owner')
  return (
    <header className={'gh gh-' + view}>
      <div className="gh-row">
        <span className="gh-mark"><img src="skc.png" alt="SKC" /></span>
        <b className="gh-name">PARKAR</b>
        <span className="gh-time num">{fmtTime(now)}</span>
        <span className={'gh-net' + (net ? ' off' : waiting ? ' wait' : '')}><i />{net ? 'Offline' : waiting ? 'Sending' : 'Online'}{waiting > 0 && <b className="num"> · {waiting}</b>}</span>
      </div>
      {((flow && flow !== 'Pay by UPI') || (!flow && tabs.length < 2)) && <div className={'gh-flow ' + view}><Ico n={view === 'entry' ? 'scan' : 'out'} size={18} />{view === 'entry' ? 'Entry gate' : 'Exit gate'}{flow && <small>· {flow}</small>}</div>}
      {!flow && tabs.length > 1 && <nav className="gh-tabs" aria-label="Choose gate">
        {tabs.map(v => <a key={v} href={'#/' + v} className={'gh-tab ' + v + (view === v ? ' on' : '')} aria-current={view === v}>
          <Ico n={v === 'entry' ? 'scan' : 'out'} size={18} />{v === 'entry' ? 'Entry' : 'Exit'}</a>)}
      </nav>}
    </header>
  )
}

/** A POS that the Owner has not approved yet: scan the setup QR from the dashboard (Devices). */
function PosSetup({ error }: { error: string }) {
  const [scan, setScan] = useState(false)
  const [link, setLink] = useState('')
  const [msg, setMsg] = useState('')
  const use = (value: string) => {
    const m = /#\/((?:pos|pair-pos)\/[a-f0-9]{64})/i.exec(value.trim()) ?? /^((?:pos|pair-pos)\/[a-f0-9]{64})$/i.exec(value.trim())
    if (!m) { setMsg('That is not a PARKAR POS setup code. Use the QR from Owner dashboard → Devices.'); return false }
    location.hash = '/' + m[1]
    return true
  }
  return <div className="screen">
    <header className="gh gh-entry"><div className="gh-row"><span className="gh-mark"><img src="skc.png" alt="SKC" /></span><b className="gh-name">PARKAR</b></div></header>
    <main className="content"><section className="card stack pos-setup">
      <h2>Set up this POS</h2>
      <p className="muted small">The gates are locked to approved POS machines. On your phone, open the Owner dashboard → <b>POS devices</b>, add this POS, then scan its setup QR here.</p>
      <button className="btn btn-primary btn-xl" onClick={() => setScan(true)}><Ico n="qr" size={24} /> Scan setup QR</button>
      {scan && <PlateScanner onClose={() => setScan(false)} onRead={() => setMsg('That was a number plate. Point the camera at the setup QR.')} onQr={value => { const ok = use(value); if (ok) setScan(false); return ok }} />}
      <label className="lbl" htmlFor="pos-link">Or paste the setup link</label>
      <input id="pos-link" className="field small-field" value={link} onChange={e => setLink(e.target.value)} placeholder="https://…#/pos/…" autoComplete="off" />
      <button className="btn btn-ghost" disabled={!link.trim()} onClick={() => use(link)}>Use this link</button>
      {(msg || (error && !/not set up/i.test(error))) && <p className="msg bad" role="alert">{msg || error}</p>}
    </section></main>
  </div>
}
