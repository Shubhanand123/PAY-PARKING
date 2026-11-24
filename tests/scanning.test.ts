import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateSkew, findRowSplit, locatePlate, type Gray } from '../src/plate-locate.ts'
import { createWedgeReader } from '../src/scanner-wedge.ts'

// A noisy grey street with a light plate carrying dark blocky "characters".
function scene(width: number, height: number, plate: { x: number; y: number; w: number; h: number; lines?: 1 | 2; skew?: number; inverted?: boolean }) {
  const data = new Uint8Array(width * height)
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let i = 0; i < data.length; i++) data[i] = 90 + rnd() * 30
  // Some unrelated structure: a long horizontal bumper line and a big dark window.
  for (let x = 0; x < width; x++) for (let y = 0; y < 3; y++) data[(Math.round(height * .2) + y) * width + x] = 30
  for (let y = 5; y < height * .15; y++) for (let x = 10; x < width * .4; x++) data[y * width + x] = 40
  const bg = plate.inverted ? 25 : 235, ink = plate.inverted ? 220 : 20
  const slope = Math.tan((plate.skew ?? 0) * Math.PI / 180)
  const lines = plate.lines ?? 1
  const chars = lines === 1 ? 10 : 5
  const set = (x: number, y: number, v: number) => {
    const yy = Math.round(y - (x - plate.x - plate.w / 2) * slope)
    if (x >= 0 && x < width && yy >= 0 && yy < height) data[yy * width + x] = v
  }
  for (let y = plate.y; y < plate.y + plate.h; y++) for (let x = plate.x; x < plate.x + plate.w; x++) set(x, y, bg)
  const lineH = plate.h / lines
  for (let l = 0; l < lines; l++) {
    const top = plate.y + l * lineH + lineH * .2, bottom = plate.y + (l + 1) * lineH - lineH * .2
    const cw = plate.w * .9 / chars
    for (let c = 0; c < chars; c++) {
      const left = plate.x + plate.w * .05 + c * cw
      for (let y = Math.round(top); y < bottom; y++) for (let x = Math.round(left + cw * .15); x < left + cw * .85; x++) {
        const u = (x - left) / cw, v = (y - top) / (bottom - top)
        const stroke = u < .35 || u > .65 || v < .2 || (v > .45 && v < .6) || (c % 2 ? v > .8 : false)
        if (stroke) set(x, y, ink)
      }
    }
  }
  return { data, width, height } satisfies Gray
}

const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; w: number; h: number }) => {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.h) - Math.max(a.y, b.y))
  return ix * iy / (a.width * a.height + b.w * b.h - ix * iy)
}

test('locatePlate finds single-line, two-line and inverted plates', () => {
  for (const plate of [
    { x: 90, y: 110, w: 150, h: 34 },
    { x: 40, y: 70, w: 90, h: 52, lines: 2 as const },
    { x: 150, y: 120, w: 140, h: 32, inverted: true },
  ]) {
    const found = locatePlate(scene(320, 180, plate))
    assert.ok(found, 'no plate found for ' + JSON.stringify(plate))
    assert.ok(overlap(found, plate) > .5, `weak overlap ${overlap(found, plate).toFixed(2)} for ${JSON.stringify(plate)} got ${JSON.stringify(found)}`)
  }
})

test('locatePlate returns nothing for a plain frame', () => {
  const data = new Uint8Array(320 * 180).fill(120)
  assert.equal(locatePlate({ data, width: 320, height: 180 }), undefined)
})

test('estimateSkew measures the tilt of the text', () => {
  for (const skew of [-8, 0, 6]) {
    const img = scene(200, 80, { x: 10, y: 22, w: 180, h: 36, skew })
    const crop = { data: img.data, width: img.width, height: img.height }
    assert.ok(Math.abs(estimateSkew(crop) - skew) <= 1.5, `skew ${skew} read as ${estimateSkew(crop)}`)
  }
})

test('findRowSplit separates two-line plates only', () => {
  const two = scene(120, 64, { x: 0, y: 0, w: 120, h: 64, lines: 2 })
  const split = findRowSplit(two)
  assert.ok(split !== undefined && split > 24 && split < 40, 'split at ' + split)
  const one = scene(120, 40, { x: 0, y: 0, w: 120, h: 40 })
  assert.equal(findRowSplit(one), undefined)
})

test('wedge reader catches fast scanner bursts and ignores people typing', () => {
  const scans: string[] = []
  const key = createWedgeReader(value => scans.push(value))
  const type = (text: string, start: number, gap: number) => {
    let t = start
    for (const ch of text) { key(ch, t); t += gap }
    return key('Enter', t)
  }
  assert.equal(type('https://p.example/#/t/abc123', 0, 8), true)
  assert.equal(type('GA01AB1234', 10_000, 180), false)
  assert.equal(type('T123', 20_000, 5), false) // too short to be a ticket QR
  key('x', 30_000) // a stray slow key before the burst must not stick to the front
  assert.equal(type('T-000045', 31_000, 10), true)
  assert.deepEqual(scans, ['https://p.example/#/t/abc123', 'T-000045'])
})

test('plateFromText drops a border stroke read as 1 or I', async () => {
  const { plateFromText } = await import('../src/plate-reading.ts')
  assert.equal(plateFromText('1GA 07 AB 1234', 60)?.plate, 'GA07AB1234')
  assert.equal(plateFromText('GA 07 AB 1234 I', 60)?.plate, 'GA07AB1234')
  assert.equal(plateFromText('GA 03 K\n5678', 80)?.plate, 'GA03K5678')
  assert.equal(plateFromText('GA 07 AB 12345', 60), undefined)
})
