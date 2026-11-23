import { auth } from './parking-auth'
import { Login } from './Login'
import { apiEnabled, callParking, deviceKey, ParkingApiError, setDeviceKey, type Snapshot } from './parking-api'
import type { DB } from './engine'
import { useCallback, useEffect, useState } from 'react'
import { useDB, Ico, Toast } from './ui'
import { Entry, Exit, Customer } from './Gate'
import { Owner } from './Owner'

type View = 'entry' | 'exit' | 'owner'
const route = () => location.hash.replace(/^#\/?/, '')

export default function App() {
  return apiEnabled ? <ConnectedApp /> : <LocalApp />
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
    setSnapshot(undefined)
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
          setDeviceKey('')
          setSnapshot(undefined)
          if (sessionId) await auth?.auth.signOut({ scope: 'local' })
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
      throw new Error('Use your gate mobile number and password to sign in.')
    }
    setDeviceKey(key)
    setSnapshot(response.snapshot)
  }

  async function signOut() {
    setDeviceKey('')
    setSnapshot(undefined)
    setError('')
    await auth?.auth.signOut({ scope: 'local' })
    location.hash = ''
  }

  if (r.startsWith('t/')) {
    return customer ? <ParkingApp db={customer} /> : <main className="content"><p role="status">{error || 'Loading ticket…'}</p></main>
  }
  if (snapshot && (sessionId || deviceKey())) {
    return <><ParkingApp db={snapshot.db} role={snapshot.role} signOut={signOut} /><div className="content">
      {error && <p role="alert">{error} Reconnect before collecting cash.</p>}
    </div></>
  }
  if (sessionId === undefined || ((sessionId || deviceKey()) && !error)) {
    return <main className="screen"><div className="content"><p role="status">Connecting to parking records…</p></div></main>
  }
  return <Login onOwnerSetup={activateOwner} error={error} />
}

function ParkingApp({ db, role, signOut }: { db: DB; role?: View; signOut?: () => void }) {
  const [r, setR] = useState(route())
  const [toast, setToast] = useState<{ m: string; bad?: boolean } | null>(null)
  useEffect(() => { const f = () => setR(route()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  const say = useCallback((m: string, bad?: boolean) => setToast({ m, bad }), [])
  const done = useCallback(() => setToast(null), [])

  if (r.startsWith('t/')) return (
    <div className="screen">
      <header className="hero slim"><div className="glow g1" /><div className="hero-row"><div className="brand"><span className="brand-mark"><Ico n="p" /></span>{db.settings.siteName}</div></div><h1>Your parking ticket</h1></header>
      <main className="content"><Customer db={db} token={r.slice(2)} /><a className="link center" href="#/exit">Staff: open in gate app</a></main>
    </div>
  )

  const requested: View = r === 'exit' ? 'exit' : r === 'owner' ? 'owner' : 'entry'
  const view = role ?? requested
  const me = db.staff.find(s => s.id === (view === 'entry' ? 'ravi' : view === 'exit' ? 'sunil' : 'owner'))!
  const wide = view === 'owner'
  return (
    <div className={wide ? 'screen wide' : 'screen'}>
      <header className={view === 'owner' ? 'hero' : 'hero compact'}>
        <div className="glow g1" /><div className="glow g2" />
        <div className="hero-row">
          <div className="brand"><span className="brand-mark"><Ico n="p" /></span>{db.settings.operator}</div>
          {signOut ? <button className="demo-tag signout" onClick={signOut}>Sign out</button> : <span className="demo-tag">Local mode · this browser</span>}
        </div>
        {!role && <nav className="switch" aria-label="Choose screen">
          {(['entry', 'exit', 'owner'] as View[]).filter(v => !role || role === 'owner' || role === v).map(v => <a key={v} href={'#/' + v} className={'sw-btn' + (view === v ? ' on' : '')} aria-current={view === v}>{v === 'entry' ? 'Entry gate' : v === 'exit' ? 'Exit gate' : 'Owner'}</a>)}
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
