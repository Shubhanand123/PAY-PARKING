import { createClient } from '@supabase/supabase-js'

const api = import.meta.env.VITE_PARKING_API
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
export const auth = api && key ? createClient(new URL(api).origin, key) : null

export function indianMobile(input: string) {
  const digits = input.replace(/\D/g, '')
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits
  if (!/^[6-9]\d{9}$/.test(local)) throw new Error('Enter a valid 10-digit Indian mobile number.')
  return '+91' + local
}
