import { isSupportedPlateFormat, normPlate } from './engine.ts'

export type PlateReading = { plate: string; confidence: number }

export function plateFromText(text: string, confidence: number): PlateReading | undefined {
  const lines = text.toUpperCase().split(/\r?\n/).map(line => normPlate(line.replace(/^\s*IND(?:\s+|$)/, ''))).filter(Boolean)
  const joined = lines.slice(0, -1).map((line, i) => line + lines[i + 1])
  const possible = [...lines, ...joined]
  const plate = possible.find(isSupportedPlateFormat)
  return plate ? { plate, confidence: confidence / 100 } : undefined
}

export function rankPlateFrames(frames: readonly (PlateReading | undefined)[]) {
  const votes = new Map<string, { plate: string; count: number; confidence: number }>()
  for (const result of frames) {
    if (!result || result.confidence < .45) continue
    const rank = votes.get(result.plate) ?? { plate: result.plate, count: 0, confidence: 0 }
    rank.count++
    rank.confidence += result.confidence
    votes.set(result.plate, rank)
  }
  const ranked = [...votes.values()].sort((a, b) => b.count - a.count || b.confidence - a.confidence)
  const [best, second] = ranked
  const lastTwo = frames.slice(-2)
  const fast = Boolean(best && !second && lastTwo.length === 2
    && lastTwo.every(frame => frame?.plate === best.plate && frame.confidence >= .86))
  const stable = Boolean(best && isSupportedPlateFormat(best.plate) && (fast || (best.count >= 3 && best.count > (second?.count ?? 0) && best.confidence / best.count >= .75)))
  return { stable, best: best && { plate: best.plate, confidence: best.confidence / best.count }, alternatives: ranked.slice(1, 4).map(item => item.plate) }
}

const confusingPairs = new Set(['VY', 'OQ', 'DO', 'MN', 'PR', 'BD', '0O', '1I', '5S', '8B', '2Z', '6G'])

export function differsByOneConfusableCharacter(read: string, stored: string) {
  if (read.length !== stored.length || read.length < 6) return false
  let differences = 0
  for (let i = 0; i < read.length; i++) {
    if (read[i] === stored[i]) continue
    const pair = read[i] + stored[i]
    if (++differences > 1 || !(confusingPairs.has(pair) || confusingPairs.has(stored[i] + read[i]))) return false
  }
  return differences === 1
}

export function ticketTokenFromQr(value: string) {
  return /#\/t\/([a-f0-9]{32})$/i.exec(value.trim())?.[1].toLowerCase()
}
