import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

// An unclosed brace silently disables every rule after it, so check each stylesheet balances.
test('every stylesheet has balanced braces', () => {
  for (const file of readdirSync('src').filter(f => f.endsWith('.css'))) {
    const css = readFileSync('src/' + file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/"[^"]*"|'[^']*'/g, '')
    let depth = 0
    for (const ch of css) { if (ch === '{') depth++; if (ch === '}') depth--; assert.ok(depth >= 0, file + ': extra closing brace') }
    assert.equal(depth, 0, file + ': unclosed brace')
  }
})
