import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { cliReport, fixture, projectDirectory } from './support.mjs'

/**
 * The claims the README makes, each held by something that fails when the claim
 * stops being true.
 *
 * The source scans below are a **secondary** guard and are labelled as such: a
 * scan cannot tell a comparator from its replacement, which is why ordering is
 * pinned behaviourally in `test/ordering.test.mjs` and severity in
 * `test/severity-behaviour.test.mjs`. What a scan is good for is catching a
 * whole capability arriving -- a socket, a clock, a process launcher -- which
 * has no behavioural signature until the day it misbehaves.
 */

async function shippedSource() {
  const parts = []
  for (const directory of ['src', 'bin']) {
    for (const name of (await readdir(join(projectDirectory, directory))).sort()) {
      parts.push(await readFile(join(projectDirectory, directory, name), 'utf8'))
    }
  }
  return parts.join('\n')
}

test('the shipped source opens no network connection of any kind', async () => {
  const source = await shippedSource()
  for (const name of [
    'node:net', 'node:http', 'node:https', 'node:http2', 'node:dns', 'node:tls',
    'node:dgram', 'fetch(', 'XMLHttpRequest', 'WebSocket',
  ]) {
    assert.equal(source.includes(name), false, `the source reaches for ${name}`)
  }
})

test('the shipped source starts no process and runs no code it did not parse', async () => {
  const source = await shippedSource()
  for (const name of [
    'node:child_process', 'node:worker_threads', 'node:cluster', 'node:vm',
    'node:repl', 'node:inspector', 'execFile', 'execSync', 'spawnSync', 'process.binding',
  ]) {
    assert.equal(source.includes(name), false, `the source reaches for ${name}`)
  }
  assert.equal(/\bnew\s+Function\b/.test(source), false, 'the Function constructor is eval under another name')
  assert.equal(/\beval\s*\(/.test(source), false)
  assert.equal(/\bimport\s*\(/.test(source), false, 'a dynamic import decides at run time which code runs')
  // `process.exitCode` hands the code to the runtime, which flushes stdout
  // before the process leaves. `process.exit()` does not wait, and a large JSON
  // report on a pipe is precisely what it truncates.
  assert.equal(/\bprocess\.exit\s*\(/.test(source), false, 'process.exit can truncate the report on stdout')
  assert.equal(source.includes('process.exitCode = '), true, 'the exit code is handed over, not taken')
})

test('the shipped source reads no clock, no random source and no environment', async () => {
  const source = await shippedSource()
  assert.equal(/\bnew\s+Date\b/.test(source), false, 'a wall clock in the output breaks byte-identical runs')
  assert.equal(/\bDate\.\w+\s*\(/.test(source), false)
  assert.equal(/\bMath\.random\s*\(/.test(source), false)
  assert.equal(/\bperformance\.now\s*\(/.test(source), false)
  assert.equal(/\bprocess\.env\b/.test(source), false)
})

test('the shipped source never reaches for a locale-aware comparison', async () => {
  // Secondary only. `Intl.Collator` drifts exactly as `localeCompare` does and
  // spells differently, so this scan would pass while ordering became
  // machine-dependent. `test/ordering.test.mjs` is what actually holds it.
  //
  // The names appear in prose in `src/text.mjs`, deliberately -- the comment
  // there explains why neither is used -- so this scan looks for call sites
  // rather than for the words.
  const source = await shippedSource()
  for (const pattern of [
    /\.localeCompare\s*\(/,
    /\bIntl\s*\.\s*\w+\s*\(/,
    /\.toLocale\w*\s*\(/,
  ]) {
    assert.equal(pattern.test(source), false, `the source calls ${pattern}`)
  }
})

test('the shipped source writes only where it was told to, and deletes nothing', async () => {
  const source = await shippedSource()
  for (const name of [
    'rm(', 'rmdir(', 'unlink(', 'truncate(', 'appendFile(', 'createWriteStream(',
    'chmod(', 'chown(', 'rename(', 'mkdir(', 'copyFile(', 'writeFileSync(',
  ]) {
    assert.equal(source.includes(name), false, `the source reaches for ${name}`)
  }
  assert.equal((source.match(/\bwriteFile\(/g) ?? []).length, 1, 'exactly one write path, in writeRendered')
})

test('the package declares no dependencies of any kind', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.optionalDependencies, undefined)
  assert.equal(manifest.name, 'prompt-injection-fixture')
  assert.equal(manifest.type, 'module')
})

test('the tool id equals the directory name and the package name', async () => {
  const { TOOL_ID } = await import('../src/index.mjs')
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))
  assert.equal(TOOL_ID, 'prompt-injection-fixture')
  assert.equal(TOOL_ID, manifest.name)
  assert.equal(TOOL_ID, projectDirectory.split('/').pop())
  const { report } = await cliReport(fixture())
  assert.equal(report.tool, TOOL_ID)
})

test('the README claims nothing the package does not do', async () => {
  const readme = (await readFile(join(projectDirectory, 'README.md'), 'utf8')).replace(/\s+/g, ' ')
  // Each of these sentences is held by a test elsewhere in this suite. The
  // assertion here is that the sentence is still the one being held.
  for (const claim of [
    'Content never sets a directive',
    'A fixture that stopped challenging fails',
    'A bounded scan never reports what it did not read',
    'Segment text is never echoed into the report at all',
    'A symbolic link planted inside the root is refused unread',
    'Ordering is by UTF-16 code unit',
    'It is not a jailbreak corpus',
    'It is not a payload generator',
    'It does not test a real model',
    'It does not detect injection in prose',
  ]) {
    assert.ok(readme.includes(claim), `the README no longer states: ${claim}`)
  }
  assert.equal(readme.includes('Zero runtime dependencies and zero development dependencies'), true)
})

test('every shipped source file is plain ASCII, so no invisible character hides in it', async () => {
  // A literal U+2028 inside a regular expression breaks the module at load, and
  // the rest of the class is invisible in an editor. Writing the escape text
  // and checking the bytes is cheaper than finding out later.
  for (const directory of ['src', 'bin']) {
    for (const name of (await readdir(join(projectDirectory, directory))).sort()) {
      const bytes = await readFile(join(projectDirectory, directory, name))
      for (const [index, byte] of bytes.entries()) {
        const ok = byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)
        assert.ok(ok, `${directory}/${name} byte ${index} is 0x${byte.toString(16)}`)
      }
    }
  }
})

test('no test file carries a literal control, separator or bidi character either', async () => {
  // A test file may legitimately hold non-ASCII text; what it may not hold is a
  // character that is invisible in an editor. The classes are built from code
  // points here for the same reason.
  const forbidden = new Set([
    ...Array.from({ length: 32 }, (unused, index) => index).filter((code) => ![9, 10, 13].includes(code)),
    0x7f, 0x2028, 0x2029, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    0x2066, 0x2067, 0x2068, 0x2069,
    ...Array.from({ length: 32 }, (unused, index) => 0x80 + index),
  ])
  for (const name of (await readdir(join(projectDirectory, 'test'))).sort()) {
    const text = await readFile(join(projectDirectory, 'test', name), 'utf8')
    for (const character of text) {
      assert.equal(forbidden.has(character.codePointAt(0)), false, `test/${name} carries U+${character.codePointAt(0).toString(16)}`)
    }
  }
})
