import type { SupabaseClient } from '@supabase/supabase-js'

// Owner sign-in (Supabase Auth). The library is big, so it loads only when it is needed:
// when an Owner signs in, or when a sign-in is already saved on this device. A gate POS never loads it.
const api = import.meta.env.VITE_PARKING_API
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
export const authEnabled = Boolean(api && key)

let client: Promise<SupabaseClient> | undefined
let current: string | null | undefined // signed-in user id; undefined = not known yet
const listeners = new Set<(id: string | null) => void>()

export function loadAuth(): Promise<SupabaseClient | null> {
  if (!authEnabled) return Promise.resolve(null)
  client ??= import('@supabase/supabase-js').then(({ createClient }) => {
    const c = createClient(new URL(api).origin, key)
    c.auth.onAuthStateChange((_event, session) => { current = session?.user.id ?? null; listeners.forEach(l => l(current as string | null)) })
    return c
  })
  return client
}

/** Is an Owner sign-in saved on this device? (Supabase keeps it in localStorage as sb-<project>-auth-token.) */
function hasSavedLogin() {
  try {
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i) ?? ''; if (k.startsWith('sb-') && k.endsWith('-auth-token')) return true }
  } catch { /* storage blocked */ }
  return false
}
const needed = () => authEnabled && (client !== undefined || hasSavedLogin())

export async function getSession() {
  if (!needed()) return null
  return (await (await loadAuth())?.auth.getSession())?.data.session ?? null
}
export async function signOutLocal() {
  if (!needed()) return
  await (await loadAuth())?.auth.signOut({ scope: 'local' })
}
/** Calls back with the signed-in Owner's id (or null), now and whenever it changes. */
export function onSession(callback: (id: string | null) => void) {
  listeners.add(callback)
  if (!needed()) callback(null)
  else if (current !== undefined) callback(current)
  else void loadAuth()
  return () => { listeners.delete(callback) }
}

export function indianMobile(input: string) {
  const digits = input.replace(/\D/g, '')
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits
  if (!/^[6-9]\d{9}$/.test(local)) throw new Error('Enter a valid 10-digit Indian mobile number.')
  return '+91' + local
}
