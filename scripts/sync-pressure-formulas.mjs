import { readFile, writeFile } from 'node:fs/promises'

const formulas = new URL('../lib/session-pressure-formulas.js', import.meta.url)
const client = new URL('../lib/client.js', import.meta.url)
const source = (await readFile(formulas, 'utf8')).replace(/\r\n/g, '\n').split('\nexport {')[0].trim()
const original = (await readFile(client, 'utf8')).replace(/\r\n/g, '\n')
const start = '    // BEGIN shared pressure formulas'
const end = '    // END shared pressure formulas'
const first = original.indexOf(start)
const last = original.indexOf(end, first)
if (first < 0 || last < 0) throw new Error('Missing client formula markers')
const body = source.split('\n').map(line => line ? '    ' + line : '').join('\n')
const generated = original.slice(0, first) + start + '\n' + body + '\n' + original.slice(last)
if (generated !== original) {
  if (process.argv.includes('--check')) throw new Error('Client formulas are out of sync')
  await writeFile(client, generated)
}
