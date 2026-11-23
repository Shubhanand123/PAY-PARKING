export const loginAlias = (mobile: string) => mobile.replace(/\D/g, '') + '@parking-auth.example.com'

export async function pairedPassword(pin: string, pairingKey: string) {
  const bytes = new TextEncoder().encode('parking-device:' + pairingKey + ':' + pin)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return 'Pp!' + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}
