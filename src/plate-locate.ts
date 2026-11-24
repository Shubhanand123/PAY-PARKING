// Image helpers for the plate scanner. Pure functions on grayscale pixels, so they run in Node tests too.

export type Gray = { data: Uint8Array; width: number; height: number }
export type Box = { x: number; y: number; width: number; height: number }
export type Located = Box & { score: number }

export function toGray(rgba: ArrayLike<number>, width: number, height: number): Gray {
  const data = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < data.length; i++, p += 4) data[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8
  return { data, width, height }
}

export function cropGray(img: Gray, box: Box): Gray {
  const x0 = Math.max(0, Math.round(box.x)), y0 = Math.max(0, Math.round(box.y))
  const width = Math.max(1, Math.min(img.width - x0, Math.round(box.width)))
  const height = Math.max(1, Math.min(img.height - y0, Math.round(box.height)))
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) data.set(img.data.subarray((y0 + y) * img.width + x0, (y0 + y) * img.width + x0 + width), y * width)
  return { data, width, height }
}

// Otsu threshold. Returns the cut and whether the dark side is the minority (dark text on a light plate).
export function otsu(img: Gray) {
  const hist = new Array<number>(256).fill(0)
  for (const v of img.data) hist[v]++
  const total = img.data.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0, wB = 0, best = 0, cut = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2
    if (between > best) { best = between; cut = t }
  }
  return { cut, darkInk: countUpTo(hist, cut) <= total / 2 }
}
function countUpTo(hist: number[], cut: number) {
  let n = 0
  for (let i = 0; i <= cut; i++) n += hist[i]
  return n
}

// 1 where a pixel is "ink" (the minority tone after Otsu). Handles dark-on-light and light-on-dark plates.
export function inkMask(img: Gray) {
  const { cut, darkInk } = otsu(img)
  const mask = new Uint8Array(img.data.length)
  for (let i = 0; i < mask.length; i++) mask[i] = (darkInk ? img.data[i] <= cut : img.data[i] > cut) ? 1 : 0
  return mask
}

function verticalEdges(img: Gray) {
  const { data, width, height } = img
  const strength = new Uint8Array(width * height)
  let total = 0
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 1; x < width - 1; x++) {
      const d = Math.abs(data[row + x + 1] - data[row + x - 1])
      strength[row + x] = d
      total += d
    }
  }
  const mean = total / Math.max(1, (width - 2) * height)
  const threshold = Math.max(28, mean * 2.2)
  const edges = new Uint8Array(width * height)
  for (let i = 0; i < edges.length; i++) edges[i] = strength[i] >= threshold ? 1 : 0
  return edges
}

function integral(mask: Uint8Array, width: number, height: number) {
  const w = width + 1
  const sat = new Uint32Array(w * (height + 1))
  for (let y = 0; y < height; y++) {
    let run = 0
    for (let x = 0; x < width; x++) {
      run += mask[y * width + x]
      sat[(y + 1) * w + x + 1] = sat[y * w + x + 1] + run
    }
  }
  return (x0: number, y0: number, x1: number, y1: number) => {
    x0 = Math.max(0, Math.min(width, x0)); x1 = Math.max(0, Math.min(width, x1))
    y0 = Math.max(0, Math.min(height, y0)); y1 = Math.max(0, Math.min(height, y1))
    return sat[y1 * w + x1] - sat[y0 * w + x1] - sat[y1 * w + x0] + sat[y0 * w + x0]
  }
}

const aspects = [1.5, 2, 2.8, 3.8, 5]

// Finds the most plate-like box: a band dense with short vertical edges (characters), sitting in a calmer
// surround, with edges spread across its width. Expects a small image (about 320 px wide).
export function locatePlate(img: Gray): Located | undefined {
  const { width, height } = img
  if (width < 40 || height < 20) return undefined
  const sum = integral(verticalEdges(img), width, height)
  const step = Math.max(3, Math.round(width / 80))
  let best: Located | undefined
  for (let bw = Math.round(width * .2); bw <= width * .95; bw = Math.round(bw * 1.15) + 1) {
    for (const aspect of aspects) {
      const bh = Math.round(bw / aspect)
      if (bh < 10 || bh > height * .95) continue
      const padX = Math.round(bw * .2), padY = Math.round(Math.max(bh * .35, bw * .15))
      const area = bw * bh
      for (let y = 0; y + bh <= height; y += step) {
        for (let x = 0; x + bw <= width; x += step) {
          const inside = sum(x, y, x + bw, y + bh)
          const din = inside / area
          if (din < .06 || (best && din < best.score)) continue
          // Neighbouring strips: a box that cuts through the plate has busy strips beside it.
          const side = Math.max(sum(x - padX, y, x, y + bh), sum(x + bw, y, x + bw + padX, y + bh)) / (padX * bh)
          const above = sum(x, y - padY, x + bw, y), below = sum(x, y + bh, x + bw, y + bh + padY)
          const vertical = Math.max(above, below) / (bw * padY)
          // Characters spread across the plate: every sixth of the width needs some edges.
          let spread = 1
          for (let s = 0; s < 6; s++) {
            const sx = x + Math.floor(bw * s / 6), ex = x + Math.floor(bw * (s + 1) / 6)
            if (sum(sx, y, ex, y + bh) / ((ex - sx) * bh) < din * .25) { spread = 0; break }
          }
          if (!spread) continue
          const score = din - side * 1.2 - vertical * .8 + Math.min(.03, area / (width * height) * .05)
          if (score > .04 && (!best || score > best.score)) best = { x, y, width: bw, height: bh, score }
        }
      }
    }
  }
  return best && tighten(img, best)
}

// Shrinks the winning box to rows and columns that actually hold edges, so the OCR crop is tight.
function tighten(img: Gray, box: Located): Located {
  const crop = cropGray(img, box)
  const edges = verticalEdges(crop)
  const rows = new Array<number>(crop.height).fill(0), cols = new Array<number>(crop.width).fill(0)
  for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) if (edges[y * crop.width + x]) { rows[y]++; cols[x]++ }
  const span = (counts: number[], floor: number) => {
    let a = 0, b = counts.length - 1
    while (a < b && counts[a] < floor) a++
    while (b > a && counts[b] < floor) b--
    return [a, b + 1]
  }
  const [y0, y1] = span(rows, Math.max(1, crop.width * .04))
  const [x0, x1] = span(cols, 1)
  if (y1 - y0 < 6 || x1 - x0 < 12) return box
  return { x: box.x + x0, y: box.y + y0, width: x1 - x0, height: y1 - y0, score: box.score }
}

// Skew in degrees (positive = text rises to the right). Projects the tops and bottoms of strokes (ink/background
// changes between rows) along each candidate angle; at the true angle they pile into a few sharp rows.
// Changes rather than ink, so the crop's own straight edges cannot pull the answer to 0.
export function estimateSkew(img: Gray, maxDegrees = 12): number {
  const mask = centreInk(img)
  const { width, height } = img
  let bestAngle = 0, bestScore = -1
  const rows = new Float64Array(height * 3)
  for (let deg = -maxDegrees; deg <= maxDegrees; deg += 1) {
    const slope = Math.tan(deg * Math.PI / 180)
    rows.fill(0)
    for (let y = 1; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (mask[y * width + x] === mask[(y - 1) * width + x]) continue
        const r = Math.round(y + (x - width / 2) * slope + height)
        if (r >= 0 && r < rows.length) rows[r]++
      }
    }
    let score = 0
    for (const n of rows) score += n * n
    if (score > bestScore * 1.0001 || (score >= bestScore * .9999 && Math.abs(deg) < Math.abs(bestAngle))) { bestScore = score; bestAngle = deg }
  }
  return bestAngle
}

// For a squarish crop holding a two-line plate, returns the row between the two lines of text.
export function findRowSplit(img: Gray): number | undefined {
  const { width, height } = img
  if (width / height > 3.2 || height < 16) return undefined
  const mask = inkMask(img)
  const ink = new Array<number>(height).fill(0)
  for (let y = 0; y < height; y++) for (let x = Math.round(width * .05); x < width * .95; x++) ink[y] += mask[y * width + x]
  const smooth = ink.map((_, y) => ((ink[y - 1] ?? ink[y]) + ink[y] + (ink[y + 1] ?? ink[y])) / 3)
  const strong = Math.max(...smooth) * .3
  // Runs of rows that carry text. A two-line plate has two tall runs with a quiet gap between them.
  const runs: [number, number][] = []
  for (let y = 0; y < height; y++) {
    if (smooth[y] < strong) continue
    const last = runs.at(-1)
    if (last && y - last[1] <= 2) last[1] = y + 1
    else runs.push([y, y + 1])
  }
  const tall = runs.filter(([a, b]) => b - a >= height * .18)
  if (tall.length !== 2) return undefined
  const split = Math.round((tall[0][1] + tall[1][0]) / 2)
  return split > height * .25 && split < height * .75 ? split : undefined
}

// Ink as judged from the plate's centre, where the plate background dominates. Around the plate there may
// be dark car body or bright paint, which would fool a threshold taken over the whole crop.
function centreInk(img: Gray) {
  const centre = cropGray(img, { x: img.width * .2, y: img.height * .2, width: img.width * .6, height: img.height * .6 })
  const { cut, darkInk } = otsu(centre)
  const mask = new Uint8Array(img.data.length)
  for (let i = 0; i < mask.length; i++) mask[i] = (darkInk ? img.data[i] <= cut : img.data[i] > cut) ? 1 : 0
  return mask
}

// Grows a run outwards from the middle over text lines (1), bridging small empty gaps (0). A solid line (-1),
// such as the plate's frame, always stops it.
function textRun(kind: number[], maxGap: number) {
  const mid = Math.floor(kind.length / 2)
  let seed = -1
  for (let d = 0; d < kind.length / 2 && seed < 0; d++) {
    if (kind[mid - d] === 1) seed = mid - d
    else if (kind[mid + d] === 1) seed = mid + d
  }
  if (seed < 0) return undefined
  let a = seed, b = seed
  for (let gap = 0, i = seed - 1; i >= 0 && gap <= maxGap && kind[i] >= 0; i--) { if (kind[i]) { a = i; gap = 0 } else gap++ }
  for (let gap = 0, i = seed + 1; i < kind.length && gap <= maxGap && kind[i] >= 0; i++) { if (kind[i]) { b = i; gap = 0 } else gap++ }
  return [a, b + 1] as const
}

// The box around the characters themselves, without the plate's frame or anything outside the plate.
export function textBlock(img: Gray): Box {
  const { width, height } = img
  const mask = centreInk(img)
  const x0 = Math.round(width * .15), x1 = Math.round(width * .85)
  const rowKind = new Array<number>(height).fill(0)
  for (let y = 0; y < height; y++) {
    let n = 0
    for (let x = x0; x < x1; x++) n += mask[y * width + x]
    const share = n / (x1 - x0)
    rowKind[y] = share > .85 ? -1 : share > .03 ? 1 : 0
  }
  const rows = textRun(rowKind, Math.round(height * .2))
  if (!rows) return { x: 0, y: 0, width, height }
  const [y0, y1] = rows
  // A frame line runs past the text above and below; a letter's stem (B, 1, 4) stops at the text's edge.
  const margin = Math.max(2, Math.round((y1 - y0) * .15))
  const above = Math.max(0, y0 - margin), below = Math.min(height, y1 + margin)
  const colKind = new Array<number>(width).fill(0)
  for (let x = 0; x < width; x++) {
    let text = 0, outside = 0
    for (let y = y0; y < y1; y++) text += mask[y * width + x]
    for (let y = above; y < y0; y++) outside += mask[y * width + x]
    for (let y = y1; y < below; y++) outside += mask[y * width + x]
    const outsideRows = y0 - above + below - y1
    colKind[x] = text / (y1 - y0) > .85 && (!outsideRows || outside / outsideRows > .6) ? -1 : text ? 1 : 0
  }
  const cols = textRun(colKind, Math.round((y1 - y0) * 1.2)) // word gaps on plates are wide
  if (!cols) return { x: 0, y: y0, width, height: y1 - y0 }
  return { x: cols[0], y: y0, width: cols[1] - cols[0], height: y1 - y0 }
}
