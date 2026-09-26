import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_IDENTIFIER_LENGTH, byCodeUnit, decodeUtf8, describeValue, hasForbiddenCharacter,
  isDirectiveValue, isIdentifier, isPlainObject,
} from '../src/index.mjs'
import { FORBIDDEN } from './support.mjs'

test('byCodeUnit orders by UTF-16 code unit', () => {
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.equal(byCodeUnit('Z', 'a'), -1)
  assert.equal(byCodeUnit('a', 'Z'), 1)
  assert.equal(byCodeUnit('a-b', 'a_b'), -1)
  const sorted = ['assets', 'README', 'a_b', 'a-b', 'Zebra'].sort(byCodeUnit)
  assert.deepEqual(sorted, ['README', 'Zebra', 'a-b', 'a_b', 'assets'])
})

test('hasForbiddenCharacter covers all four classes and nothing legitimate', () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    assert.equal(hasForbiddenCharacter(`a${character}b`), true, name)
  }
  // Ordinary right-to-left text needs none of the overrides: the letters carry
  // their own direction, so refusing the overrides refuses nothing legitimate.
  // Built from code points so this file stays plain ASCII: a legitimate string
  // written literally is fine, but the habit of writing characters out is how a
  // literal U+2028 ends up in a regular expression and breaks a module at load.
  const arabic = String.fromCodePoint(0x627, 0x644, 0x639, 0x631, 0x628, 0x64a, 0x629)
  const hebrew = String.fromCodePoint(0x5e2, 0x5d1, 0x5e8, 0x5d9, 0x5ea)
  const emoji = String.fromCodePoint(0x1f512)
  const replacement = String.fromCodePoint(0xfffd)
  for (const legitimate of [
    'plain words and spaces',
    `Arabic: ${arabic}`,
    `Hebrew: ${hebrew}`,
    `emoji: ${emoji}`,
    `a replacement character: ${replacement}`,
  ]) {
    assert.equal(hasForbiddenCharacter(legitimate), false, legitimate)
  }
  // Tab, newline and carriage return are refused in an identifier and collapsed
  // to a space in an excerpt -- two routes to the same result.
  assert.equal(hasForbiddenCharacter('tabs\tinside'), true)
})

test('isIdentifier refuses the empty, the padded, the over-long and the controlled', () => {
  assert.equal(isIdentifier('vendor-note'), true)
  assert.equal(isIdentifier(''), false)
  assert.equal(isIdentifier(' padded '), false)
  assert.equal(isIdentifier('x'.repeat(MAX_IDENTIFIER_LENGTH)), true)
  assert.equal(isIdentifier('x'.repeat(MAX_IDENTIFIER_LENGTH + 1)), false)
  assert.equal(isIdentifier(5), false)
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    assert.equal(isIdentifier(`a${character}b`), false, name)
  }
})

test('isDirectiveValue is a label check, not a prose check', () => {
  assert.equal(isDirectiveValue('vendor-preferred'), true)
  assert.equal(isDirectiveValue('a label with spaces'), true)
  assert.equal(isDirectiveValue(''), false)
  assert.equal(isDirectiveValue('x'.repeat(201)), false)
  assert.equal(isDirectiveValue(5), false)
  assert.equal(isDirectiveValue(`a${FORBIDDEN['bidi RLO']}b`), false)
})

test('decodeUtf8 lets the decoder decide, and returns no text when it refuses', () => {
  assert.deepEqual(decodeUtf8(new Uint8Array([0x61, 0x62])), { ok: true, text: 'ab' })
  assert.deepEqual(decodeUtf8(new Uint8Array([0xff])), { ok: false, reason: 'not-utf8' })
  // A legitimate replacement character decodes; it is not evidence of anything.
  assert.equal(decodeUtf8(new Uint8Array([0xef, 0xbf, 0xbd])).ok, true)
  // A byte-order mark is consumed by the decoder rather than handed to the JSON
  // parser, which would refuse it. A file written on Windows still checks.
  assert.deepEqual(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), { ok: true, text: 'a' })
})

test('describeValue says the shape and never the value', () => {
  assert.equal(describeValue(undefined), 'nothing')
  assert.equal(describeValue(null), 'null')
  assert.equal(describeValue(true), 'true')
  assert.equal(describeValue(3), 'an integer')
  assert.equal(describeValue(3.5), 'a number')
  assert.equal(describeValue('secret'), 'a string of 6 character(s)')
  assert.equal(describeValue(['a', 'b']), 'an array of 2 item(s)')
  assert.equal(describeValue({ a: 1 }), 'an object')
  assert.equal(describeValue(() => {}), 'a function')
})

test('isPlainObject refuses arrays, null and instances dressed up as objects', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject(Object.create(null)), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject(new Date(0)), false)
  assert.equal(isPlainObject('a'), false)
})
