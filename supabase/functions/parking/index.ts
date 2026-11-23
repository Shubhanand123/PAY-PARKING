import * as parking from '../../../src/engine.ts'

const endpoint = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-device-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
}
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers })

async function database<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(endpoint + '/rest/v1/' + path, {
    ...options,
    headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json', ...options.headers },
  })
  if (!response.ok) throw new Error('Database request failed.')
  return response.json()
}

const actions = {
  createEntry: { roles: ['entry', 'owner'], fn: parking.createEntry, checks: ['text', 'text', 'integer', 'optionalText'] },
  markPrinted: { roles: ['entry', 'exit', 'owner'], fn: parking.markPrinted, checks: ['text'] },
  logLookup: { roles: ['exit', 'owner'], fn: parking.logLookup, checks: ['text', 'lookup'] },
  takeCash: { roles: ['exit', 'owner'], fn: parking.takeCash, checks: ['text', 'integer', 'integer'] },
  recordExit: { roles: ['exit', 'owner'], fn: parking.recordExit, checks: ['text'] },
  cancelTicket: { roles: ['exit', 'owner'], fn: parking.cancelTicket, checks: ['text', 'text'] },
  publishTariff: { roles: ['owner'], fn: parking.publishTariff, checks: ['integer', 'rates', 'text'] },
  saveSettings: { roles: ['owner'], fn: parking.saveSettings, checks: ['settings'] },
}

const isInteger = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100000000
const isText = (value: unknown) => typeof value === 'string' && value.length <= 500
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function valid(kind: string, value: unknown, db: parking.DB): boolean {
  switch (kind) {
    case 'text': return isText(value)
    case 'optionalText': return value == null || isText(value)
    case 'integer': return isInteger(value)
    case 'lookup': return value === 'plate' || value === 'qr' || value === 'search'
    case 'rates': return isObject(value) && Object.keys(value).length === db.categories.length && db.categories.every(({ id }) => {
      const rate = value[id]
      return isObject(rate) && isInteger(rate.firstHours) && Number(rate.firstHours) >= 1 && Number(rate.firstHours) <= 24
        && ['firstPaise', 'perHourPaise', 'capPaise'].every(k => isInteger(rate[k]))
    })
    case 'settings':
      return isObject(value) && Object.keys(value).length === 7
        && ['siteName', 'operator', 'address', 'phone'].every(k => isText(value[k]))
        && Boolean(String(value.siteName).trim() && String(value.operator).trim())
        && isInteger(value.capacity) && Number(value.capacity) > 0
        && typeof value.payAtEntry === 'boolean' && typeof value.cancelNeedsReason === 'boolean'
    default: return false
  }
}

type State = { version: number; db: parking.DB }
const statePath = 'parking_runtime?id=eq.true'
const read = () => database<State[]>(statePath + '&select=db,version')

async function state() {
  const [current] = await read()
  if (current) return current
  const db = parking.seed(false)
  db.staff = [
    { id: 'ravi', name: 'Entry gate', role: 'attendant', gate: 'Entry' },
    { id: 'sunil', name: 'Exit gate', role: 'attendant', gate: 'Exit' },
    { id: 'owner', name: 'Owner', role: 'owner', gate: 'Office' },
  ]
  await database('parking_runtime?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ id: true, db }),
  })
  const [created] = await read()
  return created
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405)
  try {
    const raw = await request.text()
    if (raw.length > 16000) return reply({ error: 'Request is too large.' }, 413)
    const body = JSON.parse(raw)
    const { action, args } = body ?? {}
    if (typeof action !== 'string' || !Array.isArray(args)) return reply({ error: 'Invalid request.' }, 400)
    if (action === 'customer') {
      if (typeof args[0] !== 'string' || !/^[a-f0-9]{32}$/.test(args[0])) return reply({ error: 'Ticket not found.' }, 404)
      const [current] = await read()
      const ticket = current?.db.tickets.find(item => item.token === args[0])
      if (!ticket) return reply({ error: 'Ticket not found.' }, 404)
      const db = current.db
      const { plate, entryBy, exitBy, cancelledBy, cancelReason, ...safeTicket } = ticket
      return reply({ db: { ...db, seq: 0, tickets: [{ ...safeTicket, plate: '••••' + plate.slice(-4) }], payments: db.payments.filter(payment => payment.ticketId === ticket.id).map(payment => ({ ...payment, by: '' })), tariffs: db.tariffs.filter(tariff => tariff.id === ticket.tariffId), audit: [], staff: [] } })
    }
    const key = request.headers.get('X-Device-Key') ?? ''
    if (!/^[a-f0-9]{64}$/.test(key)) return reply({ error: 'Enter a valid device setup code.' }, 401)
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
    const digest = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
    const [device] = await database<Array<{ role: string }>>('parking_devices?enabled=eq.true&select=role&key_hash=eq.' + digest)
    if (!device) return reply({ error: 'Device setup code is invalid or revoked.' }, 401)
    const { role } = device
    const staffId = role === 'entry' ? 'ravi' : role === 'exit' ? 'sunil' : 'owner'
    if (action === 'snapshot') return reply({ snapshot: { ...await state(), role } })
    if (!Object.hasOwn(actions, action)) return reply({ error: 'Unknown parking action.' }, 400)
    const command = actions[action as keyof typeof actions]
    if (!command.roles.includes(role)) return reply({ error: 'This device cannot perform that action.' }, 403)

    for (let attempt = 0; attempt < 5; attempt++) {
      const { db, version } = await state()
      if (args.length !== command.checks.length || !command.checks.every((kind, index) => valid(kind, args[index], db))) {
        return reply({ error: 'Check the parking details and try again.' }, 400)
      }
      const result = parking.runAction(db, staffId, command.fn as (db: parking.DB, staff: parking.Staff, ...args: unknown[]) => unknown, ...args)
      const [saved] = await database<State[]>(statePath + '&version=eq.' + version, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ db, version: version + 1 }),
      })
      if (saved) return reply({ result, snapshot: { ...saved, role } })
    }
    return reply({ error: 'Another gate changed the records. Refresh and try again.' }, 409)
  } catch (error) {
    if (error instanceof SyntaxError) return reply({ error: 'Invalid JSON.' }, 400)
    if (error instanceof parking.Refused) return reply({ error: error.message }, 409)
    return reply({ error: 'Parking server unavailable. Check the connection before retrying.' }, 503)
  }
})
