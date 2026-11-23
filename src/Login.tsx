import { callParking } from './parking-api'
import { loginAlias, pairedPassword } from './parking-identity'
import { useState, type FormEvent } from 'react'
import { auth, indianMobile } from './parking-auth'
import { Ico } from './ui'

export function Login({ onOwnerSetup, error }: {
  onOwnerSetup: (key: string) => Promise<void>
  error: string
}) {
  const [kind, setKind] = useState<'pos' | 'owner' | 'setup' | 'recover'>('pos')
  const [pairing, setPairing] = useState(() => /^#\/pair\/([a-f0-9]{64})$/.exec(location.hash)?.[1] ?? '')
  const [identifier, setIdentifier] = useState('')
  const [code, setCode] = useState('')
  const [notice, setNotice] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    setNotice('')
    try {
      if (kind === 'setup') {
        await onOwnerSetup(password.trim())
        return
      }
      if (!auth) throw new Error('Parking sign-in is unavailable.')
      const mobile = indianMobile(identifier)
      if (kind === 'recover') {
        await callParking('redeemOwnerCode', [mobile, code, password], '')
        setCode('')
        setKind('owner')
        setNotice('Password set. Sign in to the Owner dashboard.')
        return
      }
      const storageKey = 'parking-pairing-' + mobile
      const pairingKey = pairing || localStorage.getItem(storageKey) || ''
      if (kind === 'pos' && !pairingKey) throw new Error('Open the setup link from your Owner dashboard on this device first.')
      const secret = kind === 'pos' ? await pairedPassword(password, pairingKey) : password
      const { error } = await auth.auth.signInWithPassword({ email: loginAlias(mobile), password: secret })
      if (error) throw new Error(kind === 'pos' ? 'Sign-in failed. Check the mobile number, PIN, and setup link.' : 'Sign-in failed. Check the Owner mobile number and password.')
      if (kind === 'pos' && pairing) {
        localStorage.setItem(storageKey, pairing)
        setPairing('')
        history.replaceState(null, '', location.pathname + location.search)
      }
    } catch (failure) {
      setMessage((failure as Error).message)
    } finally {
      setPassword('')
      setBusy(false)
    }
  }

  function choose(next: typeof kind) {
    setKind(next)
    setIdentifier('')
    setPassword('')
    setCode('')
    setNotice('')
    setMessage('')
  }

  return <main className="screen">
    <div className="content">
      <form className="card stack device-setup" onSubmit={submit}>
        <span className="brand-mark"><Ico n="p" /></span>
        <div><h1>{kind === 'recover' ? 'Set Owner password' : 'Pay Parking'}</h1><p className="muted">{kind === 'recover' ? 'Enter the recovery code issued for your mobile number.' : kind === 'pos' ? 'Sign in to your gate POS.' : 'Sign in to the Owner dashboard.'}</p></div>
        <div className="row2 login-tabs" aria-label="Choose sign-in">
          <button type="button" className={`btn ${kind === 'pos' ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={kind === 'pos'} disabled={busy} onClick={() => choose('pos')}>Gate POS</button>
          <button type="button" className={`btn ${kind !== 'pos' ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={kind !== 'pos'} disabled={busy} onClick={() => choose('owner')}>Owner dashboard</button>
        </div>
        {kind !== 'setup' && <label className="setf"><span className="lbl">{kind === 'pos' ? 'Mobile number' : 'Owner mobile number'}</span>
          <input className="field" type="tel" autoComplete="username" value={identifier} onChange={event => setIdentifier(event.target.value)} required />
        </label>}
        {kind === 'recover' && <label className="setf"><span className="lbl">Recovery code</span>
          <input className="field" value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} required />
        </label>}
        <label className="setf"><span className="lbl">{kind === 'recover' ? 'New password · at least 10 characters' : kind === 'pos' ? 'PIN' : kind === 'owner' ? 'Password' : 'Existing owner setup code'}</span>
          <input className="field" type="password" autoComplete={kind === 'recover' ? 'new-password' : kind === 'setup' ? 'off' : 'current-password'} minLength={kind === 'recover' ? 10 : undefined} inputMode={kind === 'pos' ? 'numeric' : undefined} value={password} onChange={event => setPassword(event.target.value)} required />
        </label>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Connecting…' : kind === 'recover' ? 'Set password' : 'Sign in'}</button>
        {kind === 'pos' && pairing && <p className="small muted">This setup link will pair the device after a successful sign-in.</p>}
        {kind === 'owner' && <button type="button" className="link" disabled={busy} onClick={() => choose('recover')}>Forgot password?</button>}
        {kind === 'recover' && <button type="button" className="link" disabled={busy} onClick={() => choose('owner')}>Back to Owner sign-in</button>}
        {kind === 'owner' && <button type="button" className="link" disabled={busy} onClick={() => choose('setup')}>Use existing owner setup</button>}
        {kind === 'setup' && <button type="button" className="link" disabled={busy} onClick={() => choose('owner')}>Use mobile number instead</button>}
        {notice && <p role="status">{notice}</p>}
        {(message || error) && <p role="alert">{message || error}</p>}
      </form>
    </div>
  </main>
}
