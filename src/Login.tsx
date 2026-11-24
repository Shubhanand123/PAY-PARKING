import { useState, type FormEvent } from 'react'
import { callParking } from './parking-api'
import { auth, indianMobile } from './parking-auth'
import { loginAlias, pairedPassword } from './parking-identity'
import { Ico } from './ui'

type Step = 'credential' | 'recovery' | 'owner-setup'

const copy = {
  en: {
    subtitle: 'Sign in with your mobile number', title: 'Sign in',
    mobile: 'Mobile number', owner: 'Owner dashboard', password: 'PIN',
    forget: 'Forgot PIN / new device', code: 'One-time code',
    newPassword: 'Set a 4-digit PIN', confirm: 'Confirm PIN',
    save: 'Set PIN', back: 'Back', working: 'Checking…', old: 'Use existing owner setup',
    oldCode: 'Existing owner setup code',
    failed: 'Wrong number or PIN.', mismatch: 'The PINs do not match.',
    saved: 'PIN set. Sign in with your PIN.', newDevice: 'Set up this device first: tap Forgot PIN / new device.', unavailable: 'Parking sign-in is unavailable.',
  },
  hi: {
    subtitle: 'अपने मोबाइल नंबर से साइन इन करें', title: 'साइन इन करें',
    mobile: 'मोबाइल नंबर', owner: 'मालिक का डैशबोर्ड', password: 'पिन',
    forget: 'पिन भूल गए / नया डिवाइस', code: 'एक बार का कोड',
    newPassword: '4 अंकों का पिन बनाएँ', confirm: 'पिन दोबारा डालें',
    save: 'पिन बनाएँ', back: 'पीछे', working: 'जाँच हो रही है…', old: 'मौजूदा मालिक सेटअप का उपयोग करें',
    oldCode: 'मौजूदा मालिक सेटअप कोड',
    failed: 'नंबर या पिन गलत है।', mismatch: 'दोनों पिन एक जैसे नहीं हैं।',
    saved: 'पिन बन गया। अब पिन से साइन इन करें।', newDevice: 'पहले यह डिवाइस सेट करें: पिन भूल गए / नया डिवाइस दबाएँ।', unavailable: 'अभी पार्किंग साइन इन उपलब्ध नहीं है।',
  },
}

const deviceKeyName = (mobile: string) => 'parking-owner-device:' + mobile

export function Login({ onOwnerSetup, error }: {
  onOwnerSetup: (key: string) => Promise<void>
  error: string
}) {
  const [step, setStep] = useState<Step>('credential')
  const [language, setLanguage] = useState<'en' | 'hi'>('en')
  const [identifier, setIdentifier] = useState(() => localStorage.getItem('parking-last-mobile-owner') ?? '')
  const [code, setCode] = useState('')
  const [notice, setNotice] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const t = copy[language]
  const validMobile = /^[6-9]\d{9}$/.test(identifier)
  const normalizedCode = code.replace(/[\s-]/g, '')
  const validCode = /^[a-f0-9]{32}$/i.test(normalizedCode)
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
      if (recovering) {
        const response = await callParking<{ deviceKey: string }>('redeemOwnerCode', [mobile, normalizedCode, password], '')
        localStorage.setItem(deviceKeyName(mobile), response.result.deviceKey)
        localStorage.setItem('parking-last-mobile-owner', identifier)
        go('credential')
        setNotice(t.saved)
        return
      }
      if (!auth) throw new Error(t.unavailable)
      const deviceKey = localStorage.getItem(deviceKeyName(mobile))
      if (!deviceKey) throw new Error(t.newDevice)
      const result = await auth.auth.signInWithPassword({ email: loginAlias(mobile), password: await pairedPassword(password, deviceKey) })
      if (result.error) throw new Error(t.failed)
      localStorage.setItem('parking-last-mobile-owner', identifier)
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

  const title = step === 'owner-setup' ? t.old : recovering ? t.newPassword : t.title
  const credentialLabel = step === 'owner-setup' ? t.oldCode : recovering ? t.newPassword : t.password

  return <div className="screen parking-login" lang={language}>
    <header className="hero">
      <span className="glow g1" aria-hidden="true" /><span className="glow g2" aria-hidden="true" />
      <div className="hero-row">
        <span className="brand"><span className="brand-mark" aria-hidden="true"><Ico n="p" /></span>Pay Parking</span>
        <button className="chip-btn login-lang" type="button" onClick={() => setLanguage(language === 'en' ? 'hi' : 'en')} aria-label={language === 'en' ? 'Switch to Hindi' : 'Switch to English'}>{language === 'en' ? 'हिन्दी' : 'English'}</button>
      </div>
      <h1>{t.owner}</h1>
      <p>{t.subtitle}</p>
    </header>
    <main className="content">
      <form className="card stack login-card" onSubmit={submit}>
        <h2>{title}</h2>
        {step !== 'owner-setup' && <label className="setf" htmlFor="login-mobile"><span className="lbl">{t.mobile}</span>
          <div className="login-prefix"><span aria-hidden="true">+91</span>
            <input id="login-mobile" className="field num" type="tel" inputMode="numeric" autoComplete="tel-national"
              placeholder="98765 43210" value={identifier} onChange={event => updateMobile(event.target.value)} disabled={busy} required />
          </div>
        </label>}
        {recovering && <label className="setf"><span className="lbl">{t.code}</span>
          <input className="field" value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code"
            autoCapitalize="none" spellCheck={false} maxLength={48} disabled={busy} required />
        </label>}
        <label className="setf"><span className="lbl">{credentialLabel}</span>
          <input key={step} className={'field' + (step === 'owner-setup' ? '' : ' pin-field')} type="password"
            autoComplete={recovering ? 'new-password' : step === 'owner-setup' ? 'off' : 'current-password'}
            inputMode={step === 'owner-setup' ? undefined : 'numeric'} maxLength={step === 'owner-setup' ? undefined : 4}
            value={password} onChange={event => setPassword(step === 'owner-setup' ? event.target.value : event.target.value.replace(/\D/g, '').slice(0, 4))}
            disabled={busy} required />
        </label>
        {recovering && <label className="setf"><span className="lbl">{t.confirm}</span>
          <input className="field pin-field" type="password" inputMode="numeric" maxLength={4}
            autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value.replace(/\D/g, '').slice(0, 4))}
            disabled={busy} required />
        </label>}
        <button className="btn btn-primary" disabled={busy || (step === 'owner-setup' ? !password.trim()
          : !validMobile || (recovering ? !validCode || password.length !== 4 || confirm.length !== 4 : password.length !== 4))}>
          {busy ? t.working : recovering ? t.save : t.title}
        </button>
        {step === 'credential' && <button type="button" className="link" disabled={busy} onClick={() => go('recovery')}>{t.forget}</button>}
        {step === 'credential' && <button type="button" className="link subtle" disabled={busy} onClick={() => go('owner-setup')}>{t.old}</button>}
        {step !== 'credential' && <button type="button" className="link" disabled={busy} onClick={() => go('credential')}>{t.back}</button>}
        {notice && <p className="msg ok" role="status">{notice}</p>}
        {(message || error) && <p className="msg bad" role="alert">{message || error}</p>}
      </form>
    </main>
  </div>
}
