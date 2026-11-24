import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { pairedPassword } from '../src/parking-identity.ts'

// Owner PIN: a one-time code approves a device and hands it the Owner's device key; the stored
// password is derived from key + PIN, and every approved device gets the same key.
test('owner PIN setup derives the password from a shared device key', async () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')
  const codes = ['0123456789abcdef0123456789abcdef', 'fedcba9876543210fedcba9876543210']
  let row: Record<string, unknown> = { mobile: '+918830048254', code_hash: sha(codes[0]), expires_at: '2999-01-01', used_at: null, device_key: null }
  let password = ''
  let handler!: (request: Request) => Promise<Response>
  const env: Record<string, string> = { SUPABASE_URL: 'https://parking.test', SUPABASE_SERVICE_ROLE_KEY: 'local-service', PARKING_OPEN_ACCESS: 'true' }
  ;(globalThis as { Deno?: unknown }).Deno = { env: { get: (k: string) => env[k] }, serve: (cb: typeof handler) => { handler = cb } }
  globalThis.fetch = async (resource, options) => {
    const url = new URL(String(resource))
    if (url.pathname === '/rest/v1/parking_owner_recovery') {
      const matches = url.searchParams.get('code_hash') === null || url.searchParams.get('code_hash') === 'eq.' + row.code_hash
      if (options?.method === 'PATCH') { if (matches && row.used_at === null || url.searchParams.get('code_hash') === null) { row = { ...row, ...JSON.parse(String(options.body)) }; return Response.json([row]) } return Response.json([]) }
      return Response.json(matches && row.used_at === null ? [row] : [])
    }
    if (url.pathname === '/auth/v1/admin/users' && options?.method !== 'POST') return Response.json({ users: [] })
    if (url.pathname === '/auth/v1/admin/users') { password = JSON.parse(String(options!.body)).password; return Response.json({ id: 'owner' }) }
    return Response.json([])
  }
  await import('../supabase/functions/parking/index.ts')
  const redeem = async (code: string, pin: string) => {
    const r = await handler(new Request('https://parking.test/functions/v1/parking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'redeemOwnerCode', args: ['+918830048254', code, pin] }) }))
    return { status: r.status, body: await r.json() }
  }
  assert.equal((await redeem(codes[0], '12')).status, 400, 'PIN too short')
  const first = await redeem(codes[0], '4821')
  assert.equal(first.status, 200)
  const key = first.body.result.deviceKey as string
  assert.match(key, /^[a-f0-9]{64}$/)
  assert.equal(password, await pairedPassword('4821', key), 'stored password = key + PIN')
  assert.notEqual(password, '4821')
  assert.equal((await redeem(codes[0], '4821')).status, 400, 'a code works once')
  // A second device (new code) receives the same key, so both devices sign in with the PIN.
  row = { ...row, code_hash: sha(codes[1]), used_at: null }
  const second = await redeem(codes[1], '4821')
  assert.equal(second.body.result.deviceKey, key)
})
