// Ticket page (customer's phone): smiley rating, raise a complaint (bottom sheet), follow it and write back.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { fmtDT, type DB, type Ticket } from './engine'
import { COMPLAINT_TYPES, MAX_PHOTOS, SMILEYS, STATUS_LABEL, customerComplaints, validMobile, type ComplaintType } from './complaints'
import * as api from './care-api'
import './care.css'

export function CustomerCare({ db: given, t, token }: { db: DB; t: Ticket; token: string }) {
  const [fresh, setFresh] = useState<DB>()
  useEffect(() => setFresh(undefined), [given]) // the next poll brings the same data
  const db = fresh ?? given
  const [sheet, setSheet] = useState(false)
  const [msg, setMsg] = useState('')
  const rating = (db.ratings ?? []).find(r => r.ticketId === t.id)
  const mine = customerComplaints(db, t).sort((a, b) => b.at - a.at)
  const rate = async (score: number) => {
    setMsg('')
    try { setFresh((await api.rateVisit(token, score)).db) } catch (e) { setMsg((e as Error).message) }
  }
  return (
    <>
      <section className="cp-card cc-rate">
        <h2 className="cp-h">{rating ? 'Thank you for your rating' : 'How was your parking?'}</h2>
        <div className="cc-faces" role="radiogroup" aria-label="Rate your visit">
          {SMILEYS.map(s => <button key={s.score} role="radio" aria-checked={rating?.score === s.score} className={rating?.score === s.score ? 'on' : ''} onClick={() => void rate(s.score)}>
            <span aria-hidden="true">{s.face}</span><small>{s.label}</small></button>)}
        </div>
        {rating && rating.score <= 2 && !mine.length && <p className="cp-note">Sorry about that. <button className="link" onClick={() => setSheet(true)}>Tell us what went wrong</button> and we will reply here.</p>}
        {msg && <p className="cp-note bad" role="alert">{msg}</p>}
        <button className="btn btn-ghost cc-raise" onClick={() => setSheet(true)}>Raise a complaint</button>
      </section>
      {mine.map(c => <ComplaintThread key={c.id} c={c} token={token} onFresh={setFresh} />)}
      {sheet && <ComplaintSheet db={db} token={token} onClose={() => setSheet(false)} onDone={d => { setFresh(d); setSheet(false) }} />}
    </>
  )
}

function ComplaintThread({ c, token, onFresh }: { c: ReturnType<typeof customerComplaints>[number]; token: string; onFresh: (db: DB) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const send = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setMsg('')
    try { onFresh((await api.customerMessage(token, c.id, text)).db); setText('') } catch (err) { setMsg((err as Error).message) } finally { setBusy(false) }
  }
  const thread = [{ at: c.at, from: 'customer' as const, text: c.message }, ...c.messages]
  return (
    <section className="cp-card cc-thread">
      <div className="cc-thread-head"><div><small>Complaint</small><b className="num">{c.id}</b></div><span className={'cc-st ' + c.status}>{STATUS_LABEL[c.status]}</span></div>
      <p className="cp-fine">{COMPLAINT_TYPES[c.type]} · {fmtDT(c.at)}{c.photos ? ` · ${c.photos} photo${c.photos > 1 ? 's' : ''}` : ''}</p>
      <div className="cx-thread">
        {thread.map((m, i) => <div key={i} className={'cx-msg ' + (m.from === 'owner' ? 'from-owner' : 'from-me')}><p>{m.text}</p><small>{m.from === 'owner' ? 'Parking office' : 'You'} · {fmtDT(m.at)}</small></div>)}
        {!c.messages.some(m => m.from === 'owner') && <p className="cp-fine">We have your complaint and will reply on this page. Keep this page or your slip.</p>}
      </div>
      {c.status !== 'closed'
        ? <form className="cc-reply" onSubmit={e => void send(e)}>
          <input className="field" maxLength={1000} value={text} onChange={e => setText(e.target.value)} placeholder="Write a message" aria-label="Write a message" />
          <button className="btn btn-primary" disabled={busy || !text.trim()}>Send</button>
        </form>
        : <p className="cp-fine">This complaint is closed.</p>}
      {msg && <p className="cp-note bad" role="alert">{msg}</p>}
    </section>
  )
}

function ComplaintSheet({ db, token, onClose, onDone }: { db: DB; token: string; onClose: () => void; onDone: (db: DB) => void }) {
  const [name, setName] = useState('')
  const [mobile, setMobile] = useState('')
  const [type, setType] = useState<ComplaintType | ''>('')
  const [message, setMessage] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => { const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', esc); return () => removeEventListener('keydown', esc) }, [onClose])
  const s = db.settings
  const add = async (files: FileList | null) => {
    setMsg('')
    for (const f of Array.from(files ?? []).slice(0, MAX_PHOTOS - photos.length)) {
      try { const p = await api.shrinkPhoto(f); setPhotos(x => x.length < MAX_PHOTOS ? [...x, p] : x) } catch (e) { setMsg((e as Error).message) }
    }
    if (file.current) file.current.value = ''
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!type) { setMsg('Choose what the complaint is about.'); return }
    if (!validMobile(mobile)) { setMsg('Enter a 10-digit Indian mobile number.'); return }
    setBusy(true); setMsg('')
    try { onDone((await api.addComplaint(token, { name, mobile, type, message, consent }, photos)).db) }
    catch (err) { setMsg((err as Error).message) } finally { setBusy(false) }
  }
  return createPortal(
    <div className="cc-backdrop" onClick={onClose}>
      <form className="cc-sheet" role="dialog" aria-modal="true" aria-label="Raise a complaint" onClick={e => e.stopPropagation()} onSubmit={e => void submit(e)}>
        <div className="cc-grab" aria-hidden="true" />
        <div className="cc-sheet-head"><h2>Raise a complaint</h2><button type="button" className="link" onClick={onClose}>Close</button></div>
        <p className="cp-fine">We reply on this ticket page{s.phone ? <>, or call <a href={'tel:' + s.phone.replace(/[^\d+]/g, '')}>{s.phone}</a></> : ''}.</p>
        <span className="lbl">What is it about?</span>
        <div className="cc-types">{(Object.keys(COMPLAINT_TYPES) as ComplaintType[]).map(k => <button type="button" key={k} className={'chip' + (type === k ? ' on' : '')} aria-pressed={type === k} onClick={() => setType(k)}>{COMPLAINT_TYPES[k]}</button>)}</div>
        <label className="lbl" htmlFor="cc-msg">What happened?</label>
        <textarea id="cc-msg" className="field" rows={4} maxLength={1500} required value={message} onChange={e => setMessage(e.target.value)} placeholder="Tell us what happened, and what you would like us to do." />
        <span className="lbl">Photos <span className="muted">(optional, up to {MAX_PHOTOS})</span></span>
        <div className="cc-photos">
          {photos.map((p, i) => <div key={i} className="cc-ph"><img src={'data:image/jpeg;base64,' + p} alt={`Photo ${i + 1}`} /><button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => setPhotos(x => x.filter((_, j) => j !== i))}>×</button></div>)}
          {photos.length < MAX_PHOTOS && <button type="button" className="cc-ph add" onClick={() => file.current?.click()}>+ Add photo</button>}
          <input ref={file} type="file" accept="image/*" multiple hidden onChange={e => void add(e.target.files)} />
        </div>
        <div className="grid2 cc-you">
          <label><span className="lbl">Your name</span><input className="field" required maxLength={60} autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></label>
          <label><span className="lbl">Mobile number</span><input className="field" required inputMode="tel" autoComplete="tel" maxLength={16} value={mobile} onChange={e => setMobile(e.target.value)} placeholder="98xxxxxxxx" /></label>
        </div>
        <label className="cc-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
          <span>I agree that {s.operator} may use my name, mobile number, message and photos only to look into and reply to this complaint. They are deleted {180} days after the complaint is closed. <a href="#/privacy" target="_blank">Privacy policy</a></span></label>
        {msg && <p className="cp-note bad" role="alert">{msg}</p>}
        <button className="btn btn-primary btn-xl" disabled={busy || !consent}>{busy ? 'Sending…' : 'Send complaint'}</button>
      </form>
    </div>, document.body)
}
