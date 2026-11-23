import { useCallback, useEffect, useState } from 'react'
import { useDB, Ico, Toast } from './ui'
import { Entry, Exit, Customer } from './Gate'
import { Owner } from './Owner'

type View = 'entry' | 'exit' | 'owner'
const route = () => location.hash.replace(/^#\/?/, '')

export default function App() {
  const db = useDB()
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

  const view: View = r === 'exit' ? 'exit' : r === 'owner' ? 'owner' : 'entry'
  const me = db.staff.find(s => s.id === (view === 'entry' ? 'ravi' : view === 'exit' ? 'sunil' : 'owner'))!
  const wide = view === 'owner'
  return (
    <div className={wide ? 'screen wide' : 'screen'}>
      <header className={view === 'owner' ? 'hero' : 'hero compact'}>
        <div className="glow g1" /><div className="glow g2" />
        <div className="hero-row">
          <div className="brand"><span className="brand-mark"><Ico n="p" /></span>Parking</div>
          <span className="demo-tag">DEMO · data in this browser</span>
        </div>
        <nav className="switch" aria-label="Choose screen">
          {(['entry', 'exit', 'owner'] as View[]).map(v => <a key={v} href={'#/' + v} className={'sw-btn' + (view === v ? ' on' : '')} aria-current={view === v}>{v === 'entry' ? 'Entry gate' : v === 'exit' ? 'Exit gate' : 'Owner'}</a>)}
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
