import { readFileSync } from 'node:fs'

const file = process.argv[2]
const from = Number(process.argv[3] ?? 1)
const to = Number(process.argv[4] ?? 99999)
const lines = readFileSync(file, 'utf8').split(/\r?\n/)

let depth = 0
let quote = null
let esc = false
let tpl = false

function scan(s) {
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (quote !== null) { if (c === quote) quote = null; continue }
    if (tpl) { if (c === '`') tpl = false; continue }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '`') { tpl = true; continue }
    if (c === '(') depth += 1
    if (c === ')') depth -= 1
  }
}

for (let n = 1; n <= lines.length; n += 1) {
  scan(lines[n - 1] ?? '')
  if (n >= from && n <= to) {
    console.log(`${String(n).padStart(4)} d=${String(depth).padStart(3)}  ${(lines[n - 1] ?? '').trim().slice(0, 64)}`)
  }
}
