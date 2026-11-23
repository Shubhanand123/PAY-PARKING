import { useState, type FormEvent } from 'react'
import { callParking } from './parking-api'
import { auth, indianMobile } from './parking-auth'
import { loginAlias, pairedPassword } from './parking-identity'
import { Ico } from './ui'

type Step = 'credential' | 'recovery' | 'owner-setup'
type Workspace = 'pos' | 'owner'

const copy = {
  en: {
    welcome: 'Welcome back', subtitle: 'Sign in with your mobile number', title: 'Sign in',
    mobile: 'Mobile number', next: 'Next', change: 'Change number', pos: 'Gate POS', owner: 'Owner dashboard',
    pin: 'Enter your PIN', password: 'Enter your password', delete: 'Delete last digit',
    forget: 'Forgot password?', code: 'Recovery code', codeHelp: 'Enter the code issued for this mobile number.',
    newPassword: 'Set Owner password', minimum: 'Use at least 10 characters.', confirm: 'Confirm password',
    save: 'Set password', back: 'Back', working: 'Checking…', old: 'Use existing owner setup',
    oldCode: 'Existing owner setup code', pairing: 'Sign in to pair this gate device.',
    missingPair: 'Choose Forgot password and enter the setup code from your Owner.',
    failed: 'Sign-in failed. Check your number and credentials.', mismatch: 'The passwords do not match.',
    saved: 'Password set. Sign in with your new password.', unavailable: 'Parking sign-in is unavailable.',
  },
  hi: {
    welcome: 'फिर से स्वागत है', subtitle: 'अपने मोबाइल नंबर से साइन इन करें', title: 'साइन इन करें',
    mobile: 'मोबाइल नंबर', next: 'आगे', change: 'नंबर बदलें', pos: 'गेट POS', owner: 'मालिक का डैशबोर्ड',
    pin: 'अपना पिन डालें', password: 'अपना पासवर्ड डालें', delete: 'आखिरी अंक हटाएँ',
    forget: 'पासवर्ड भूल गए?', code: 'रिकवरी कोड', codeHelp: 'इस मोबाइल नंबर के लिए जारी कोड डालें।',
    newPassword: 'नया पासवर्ड बनाएँ', minimum: 'कम से कम 10 अक्षर रखें।', confirm: 'पासवर्ड दोबारा डालें',
    save: 'पासवर्ड बनाएँ', back: 'पीछे', working: 'जाँच हो रही है…', old: 'मौजूदा मालिक सेटअप का उपयोग करें',
    oldCode: 'मौजूदा मालिक सेटअप कोड', pairing: 'इस गेट डिवाइस को जोड़ने के लिए साइन इन करें।',
    missingPair: 'पासवर्ड भूल गए चुनें और मालिक से मिला सेटअप कोड डालें।',
    failed: 'साइन इन नहीं हुआ। अपना नंबर और पिन या पासवर्ड जाँचें।', mismatch: 'दोनों पासवर्ड एक जैसे नहीं हैं।',
    saved: 'पासवर्ड बन गया। नए पासवर्ड से साइन इन करें।', unavailable: 'अभी पार्किंग साइन इन उपलब्ध नहीं है।',
  },
}

export function Login({ onOwnerSetup, error }: {
  onOwnerSetup: (key: string) => Promise<void>
  error: string
}) {
  const [step, setStep] = useState<Step>('credential')
  const [workspace, setWorkspace] = useState<Workspace>(() => !location.hash.startsWith('#/pair/') && localStorage.getItem('parking-last-workspace') === 'owner' ? 'owner' : 'pos')
  const [language, setLanguage] = useState<'en' | 'hi'>('en')
  const [pairing, setPairing] = useState(() => /^#\/pair\/([a-f0-9]{64})$/.exec(location.hash)?.[1] ?? '')
  const [identifier, setIdentifier] = useState(() => localStorage.getItem('parking-last-mobile-' + workspace) ?? '')
  const [code, setCode] = useState('')
  const [notice, setNotice] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const t = copy[language]
  const validMobile = /^[6-9]\d{9}$/.test(identifier)
  const pos = workspace === 'pos'
  const validCredential = pos ? /^\d{4,8}$/.test(password) : password.length > 0
  const normalizedCode = code.replace(/[\s-]/g, '')
  const validCode = (pos ? /^[a-f0-9]{16}$/i : /^[a-f0-9]{32}$/i).test(normalizedCode)
  const recovering = step === 'recovery'

  function go(next: Step) {
    setStep(next)
    setMessage('')
    setNotice('')
    setPassword('')
    setConfirm('')
    setCode('')
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (recovering && password !== confirm) {
      setMessage(t.mismatch)
      return
    }

    setBusy(true)
    setMessage('')
    setNotice('')
    try {
      if (step === 'owner-setup') {
        await onOwnerSetup(password.trim())
        return
      }
      const mobile = indianMobile(identifier)
      const storageKey = 'parking-pairing-' + mobile
      if (recovering) {
        if (pos) {
          const result = await callParking<{ pairingKey: string }>('redeemPosCode', [mobile, normalizedCode, password], '')
          localStorage.setItem(storageKey, result.result.pairingKey)
          setPairing('')
        } else {
          await callParking('redeemOwnerCode', [mobile, normalizedCode, password], '')
        }
        localStorage.setItem('parking-last-mobile-' + workspace, identifier)
        localStorage.setItem('parking-last-workspace', workspace)
        go('credential')
        setNotice(pos ? (language === 'en' ? 'PIN created. Sign in with your new PIN.' : 'पिन बन गया। नए पिन से साइन इन करें।') : t.saved)
        return
      }
      if (!auth) throw new Error(t.unavailable)
      const pairingKey = pairing || localStorage.getItem(storageKey) || ''
      if (pos && !pairingKey) throw new Error(t.missingPair)
      const secret = pos ? await pairedPassword(password, pairingKey) : password
      const result = await auth.auth.signInWithPassword({ email: loginAlias(mobile), password: secret })
      if (result.error) throw new Error(t.failed)
      localStorage.setItem('parking-last-mobile-' + workspace, identifier)
      localStorage.setItem('parking-last-workspace', workspace)
      if (pos && pairing) {
        localStorage.setItem(storageKey, pairing)
        setPairing('')
        history.replaceState(null, '', location.pathname + location.search)
      }
    } catch (failure) {
      setMessage((failure as Error).message)
      setPassword('')
      setConfirm('')
    } finally {
      setBusy(false)
    }
  }

  function updateMobile(input: string) {
    const digits = input.replace(/\D/g, '')
    setIdentifier((digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits).slice(0, 10))
  }

  const pinTitle = language === 'en' ? 'Create your PIN' : 'अपना पिन बनाएँ'
  const title = step === 'owner-setup' ? t.old : recovering ? (pos ? pinTitle : t.newPassword) : t.title
  const credentialLabel = step === 'owner-setup' ? t.oldCode : pos ? 'PIN' : recovering ? t.newPassword : t.password

  function choose(item: Workspace) {
    const saved = localStorage.getItem('parking-last-mobile-' + item)
    if (saved || localStorage.getItem('parking-last-mobile-' + workspace) === identifier) setIdentifier(saved ?? '')
    setWorkspace(item)
    go('credential')
  }

  return <div className="screen parking-login" lang={language}>
    <header className="hero">
      <span className="glow g1" aria-hidden="true" /><span className="glow g2" aria-hidden="true" />
      <div className="hero-row">
        <span className="brand"><span className="brand-mark" aria-hidden="true"><Ico n="p" /></span>Pay Parking</span>
        <button className="chip-btn login-lang" type="button" onClick={() => setLanguage(language === 'en' ? 'hi' : 'en')} aria-label={language === 'en' ? 'Switch to Hindi' : 'Switch to English'}>{language === 'en' ? 'हिन्दी' : 'English'}</button>
      </div>
      <h1>{t.welcome}</h1>
      <p>{t.subtitle}</p>
    </header>
    <main className="content">
      <form className="card stack login-card" onSubmit={submit}>
        <h2>{title}</h2>
        {step === 'credential' && <fieldset className="login-workspaces" aria-label={t.title} disabled={busy}>
          {(['pos', 'owner'] as const).map(item => <button key={item} type="button" aria-pressed={workspace === item}
            onClick={() => choose(item)}>{t[item]}</button>)}
        </fieldset>}
        {step !== 'owner-setup' && <label className="setf" htmlFor="login-mobile"><span className="lbl">{t.mobile}</span>
          <div className="login-prefix"><span aria-hidden="true">+91</span>
            <input id="login-mobile" className="field num" type="tel" inputMode="numeric" autoComplete="tel-national"
              placeholder="98765 43210" value={identifier} onChange={event => updateMobile(event.target.value)} disabled={busy} required />
          </div>
        </label>}
        {recovering && <label className="setf"><span className="lbl">{pos ? (language === 'en' ? 'Setup code' : 'सेटअप कोड') : t.code}</span>
          <input className="field" value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code"
            autoCapitalize="none" spellCheck={false} maxLength={48} disabled={busy} required />
        </label>}
        <label className="setf"><span className="lbl">{credentialLabel}</span>
          <input key={step + workspace} className="field" type="password"
            inputMode={step !== 'owner-setup' && pos ? 'numeric' : undefined}
            autoComplete={recovering ? 'new-password' : step === 'owner-setup' ? 'off' : 'current-password'}
            minLength={recovering ? (pos ? 4 : 10) : undefined}
            maxLength={step !== 'owner-setup' && pos ? 8 : undefined}
            value={password} onChange={event => setPassword(step !== 'owner-setup' && pos ? event.target.value.replace(/\D/g, '').slice(0, 8) : event.target.value)}
            disabled={busy} required />
        </label>
        {recovering && <label className="setf"><span className="lbl">{pos ? (language === 'en' ? 'Confirm PIN' : 'पिन दोबारा डालें') : t.confirm}</span>
          <input className="field" type="password" inputMode={pos ? 'numeric' : undefined} maxLength={pos ? 8 : undefined}
            autoComplete="new-password" value={confirm} onChange={event => setConfirm(pos ? event.target.value.replace(/\D/g, '').slice(0, 8) : event.target.value)}
            disabled={busy} required />
        </label>}
        <button className="btn btn-primary" disabled={busy || (step === 'owner-setup' ? !password.trim()
          : !validMobile || (recovering ? !validCode || (pos ? !validCredential : password.length < 10) || !confirm : !validCredential))}>
          {busy ? t.working : recovering ? (pos ? pinTitle : t.save) : t.title}
        </button>
        {step === 'credential' && <button type="button" className="link" disabled={busy} onClick={() => go('recovery')}>{t.forget}</button>}
        {step === 'credential' && !pos && <button type="button" className="link subtle" disabled={busy} onClick={() => go('owner-setup')}>{t.old}</button>}
        {step !== 'credential' && <button type="button" className="link" disabled={busy} onClick={() => go('credential')}>{t.back}</button>}
        {notice && <p className="msg ok" role="status">{notice}</p>}
        {(message || error) && <p className="msg bad" role="alert">{message || error}</p>}
      </form>
    </main>
  </div>
}
