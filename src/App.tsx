import { auth } from './parking-auth'
import { Login } from './Login'
import { apiEnabled, callParking, deviceKey, openAccess, ParkingApiError, setDeviceKey, type Snapshot } from './parking-api'
import { nativeApp } from './native'
import type { DB } from './engine'
import { useCallback, useEffect, useState } from 'react'
import { useDB, Ico, Toast } from './ui'
import { Entry, Exit, Customer } from './Gate'
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
  const [snapshot, setSnapshot] = useState<Snapshot>()
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
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        if (r.startsWith('t/')) {
          const response = await callParking('customer', [r.slice(2)], '')
          if (active) setCustomer(response.db)
        } else await callParking('snapshot')
        if (active) setError('')
      } catch (failure) {
        if (!active) return
        // An expired or replaced Owner session: drop it and fall back to the open gate view.
        if (sessionId && failure instanceof ParkingApiError && failure.status === 401) await auth?.auth.signOut({ scope: 'local' })
        setError((failure as Error).message)
      }
    }
    void refresh()
    const poll = setInterval(refresh, 5000)
    return () => { active = false; clearInterval(poll) }
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
  if (!snapshot) return <main className="screen"><div className="content"><p role={error ? 'alert' : 'status'}>{error || 'Connecting to parking records…'}</p></div></main>
  return <><ParkingApp db={snapshot.db} signOut={owner ? signOut : undefined} />{error && <div className="content"><p role="alert">{error} Reconnect before collecting cash.</p></div>}</>
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
        setError((failure as Error).message)
      }
    }
    void refresh()
    const poll = setInterval(refresh, 5000)
    return () => { active = false; clearInterval(poll) }
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

function ParkingApp({ db, role: given, signOut }: { db: DB; role?: Snapshot['role']; signOut?: () => void }) {
  const role = given === 'open' ? undefined : given
  const [r, setR] = useState(route())
  const [toast, setToast] = useState<{ m: string; bad?: boolean } | null>(null)
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
  return (
    <div className={wide ? 'screen wide' : 'screen'}>
      <header className={view === 'owner' ? 'hero' : 'hero compact'}>
        <div className="glow g1" /><div className="glow g2" />
        <div className="hero-row">
          <div className="brand"><span className="brand-mark"><Ico n="p" /></span>{db.settings.operator}</div>
          {signOut ? view === 'owner' && <button className="demo-tag signout" onClick={signOut}>Sign out</button> : <span className="demo-tag">{openAccess ? 'Open access · no sign-in' : 'Local mode · this browser'}</span>}
        </div>
        {routes.length > 0 && <nav className="switch" aria-label="Choose screen">
          {routes.map(v => <a key={v} href={'#/' + v} className={'sw-btn' + (view === v ? ' on' : '')} aria-current={view === v}>{v === 'entry' ? 'Entry gate' : v === 'exit' ? 'Exit gate' : 'Owner'}</a>)}
        </nav>}
        <h1>{view === 'entry' ? 'Vehicle in' : view === 'exit' ? 'Vehicle out' : 'Dashboard'}</h1>
        <p>{me.name} · {db.settings.siteName}</p>
      </header>
      <main className="content">
        {view === 'entry' && <Entry db={db} me={me} toast={say} />}
        {view === 'exit' && <Exit db={db} me={me} toast={say} />}
        {view === 'owner' && <Owner db={db} me={me} toast={say} />}
      </main>
      {toast && <Toast msg={toast.m} tone={toast.bad ? 'bad' : 'ok'} onDone={done} />}
    </div>
  )
}
