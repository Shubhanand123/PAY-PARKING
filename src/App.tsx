import { apiEnabled, callParking, deviceKey, setDeviceKey, type Snapshot } from './parking-api'
import type { DB } from './engine'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
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
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [r, setR] = useState(route())

  useEffect(() => {
    const changed = () => setR(route())
    const updated = (event: Event) => setSnapshot((event as CustomEvent<Snapshot>).detail)
    addEventListener('hashchange', changed)
    addEventListener('parking-snapshot', updated)
    return () => { removeEventListener('hashchange', changed); removeEventListener('parking-snapshot', updated) }
  }, [])

  useEffect(() => {
    let active = true
    setError('')
    setCustomer(undefined)
    const refresh = async () => {
      try {
        if (r.startsWith('t/')) {
          const response = await callParking('customer', [r.slice(2)], '')
          if (active) setCustomer(response.db)
        } else if (deviceKey()) {
          await callParking('snapshot')
        }
        if (active) setError('')
      } catch (failure) {
        if (active) setError((failure as Error).message)
      }
    }
    void refresh()
    const poll = setInterval(refresh, 5000)
    return () => { active = false; clearInterval(poll) }
  }, [r])

  async function activate(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await callParking('snapshot', [], key.trim())
      setDeviceKey(key.trim())
      setKey('')
      setError('')
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }

  if (r.startsWith('t/')) {
    return customer ? <ParkingApp db={customer} /> : <main className="content"><p role="status">{error || 'Loading ticket…'}</p></main>
  }
  if (snapshot && deviceKey()) {
    return <><ParkingApp db={snapshot.db} role={snapshot.role} /><div className="content">
      {error && <p role="alert">{error} Reconnect before collecting cash.</p>}
      <button className="link" onClick={() => { setDeviceKey(''); setSnapshot(undefined); setError('') }}>Deactivate this device</button>
    </div></>
  }
  return <main className="screen"><div className="content"><form className="card stack" onSubmit={activate}>
    <h1>Activate parking device</h1>
    <label htmlFor="setup-key">Device setup code</label>
    <input id="setup-key" className="field" type="password" value={key} onChange={event => setKey(event.target.value)} autoComplete="off" required />
    <button className="btn btn-primary" disabled={busy}>Activate device</button>
    {error && <p role="alert">{error}</p>}
  </form></div></main>
}

function ParkingApp({ db, role }: { db: DB; role?: View }) {
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
  const view = role && role !== 'owner' ? role : requested
  const me = db.staff.find(s => s.id === (view === 'entry' ? 'ravi' : view === 'exit' ? 'sunil' : 'owner'))!
  const wide = view === 'owner'
  return (
    <div className={wide ? 'screen wide' : 'screen'}>
      <header className={view === 'owner' ? 'hero' : 'hero compact'}>
        <div className="glow g1" /><div className="glow g2" />
        <div className="hero-row">
          <div className="brand"><span className="brand-mark"><Ico n="p" /></span>{db.settings.operator}</div>
          <span className="demo-tag">{role ? 'Shared parking records' : 'Local mode · this browser'}</span>
        </div>
        <nav className="switch" aria-label="Choose screen">
          {(['entry', 'exit', 'owner'] as View[]).filter(v => !role || role === 'owner' || role === v).map(v => <a key={v} href={'#/' + v} className={'sw-btn' + (view === v ? ' on' : '')} aria-current={view === v}>{v === 'entry' ? 'Entry gate' : v === 'exit' ? 'Exit gate' : 'Owner'}</a>)}
        </nav>
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
