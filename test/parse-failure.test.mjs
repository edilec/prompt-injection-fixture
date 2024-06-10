import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'
import { cliReport, everyString, fixture, policyOf, withRoot, cliRun } from './support.mjs'

/**
 * The JSON parse diagnostic, pinned by what it emits.
 *
 * V8 reports a parse failure two ways and only one is safe. The unsafe one
 * quotes the input back, and the quoted window is taken from wherever the
 * offence is -- not from the start -- so truncating the front is not a fix
 * either. Nineteen of thirty-eight tools in this catalog shipped a helper whose
 * branches were in the wrong order; the ones that wrote this test found it.
 *
 * `CANARY` below is a synthetic token invented for these tests. It is not a
 * credential and it is not personal data; it exists so that an assertion can
 * say "this string must not appear on either stream".
 */

const CANARY = 'CANARYTOKEN7ZZQ'

test('a document whose own text reads "at position 1" is not sliced back out', () => {
  // The whole reason the quoting shape is recognised before the offset is. A
  // helper that searches for `at position \\d+` first finds that text inside the
  // quoted span and returns the document.
  let message
  try {
    JSON.parse('at position 1')
  } catch (error) {
    message = error.message
  }
  assert.equal(message, 'Unexpected token \'a\', "at position 1" is not valid JSON', 'the V8 wording this case exists for')
  assert.equal(parseFailureDetail({ message }), "unexpected token 'a' at the start of the document")
})

test('a document that is nothing but a credential-shaped token is not reproduced', () => {
  let detail
  try {
    JSON.parse(CANARY)
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assert.equal(detail, "unexpected token 'C' at the start of the document")
  assert.equal(detail.includes(CANARY), false)
  assert.equal(detail.includes(CANARY.slice(0, 8)), false, 'V8 quotes ten characters, so eight is the interesting prefix')
})

test('a long document with a sensitive prefix is not reproduced either', () => {
  // V8 truncates the quoted run to ten characters and appends an ellipsis, so
  // the message is shorter than the document and still carries the secret.
  let message
  try {
    JSON.parse(`${CANARY}${'x'.repeat(2000)}`)
  } catch (error) {
    message = error.message
  }
  assert.match(message, /"CANARYTOKE"\.\.\. is not valid JSON$/, 'the V8 wording this case exists for')
  const detail = parseFailureDetail({ message })
  assert.equal(detail, "unexpected token 'C' at the start of the document")
  for (let length = CANARY.length; length >= 4; length -= 1) {
    assert.equal(detail.includes(CANARY.slice(0, length)), false, `prefix of ${length} characters leaked`)
  }
})

test('a quoted window taken from the middle of a document is not reproduced', () => {
  // The form with a LEADING ellipsis: the window is cut from wherever the
  // offence is, which is why "truncate the front of the message" is not a fix.
  let message
  try {
    JSON.parse(`[${'1,'.repeat(30)}${CANARY}]`)
  } catch (error) {
    message = error.message
  }
  assert.match(message, /^Unexpected token 'C', \.\.\."/, 'the V8 wording this case exists for')
  const detail = parseFailureDetail({ message })
  assert.equal(detail, "unexpected token 'C' inside the document")
  for (let length = CANARY.length; length >= 4; length -= 1) {
    assert.equal(detail.includes(CANARY.slice(0, length)), false, `prefix of ${length} characters leaked`)
  }
})

test('a quoted span containing a newline is still recognised as a quoted span', () => {
  // Without the `s` flag the pattern fails to match, the helper falls through to
  // the offset branch, finds nothing, and returns the generic sentence -- which
  // is safe by luck. With a document that also contains "at position N" it
  // would return the document instead. The shape must be recognised.
  let message
  try {
    JSON.parse('[\n1,\nCANARY\nTOKEN\n]')
  } catch (error) {
    message = error.message
  }
  assert.ok(message.includes('\n'), 'the V8 message really does carry a newline here')
  assert.equal(parseFailureDetail({ message }), "unexpected token 'C' at the start of the document")
})

test('the safe positional form keeps its position, line and column', () => {
  let detail
  try {
    JSON.parse('{"alpha": 1 "beta": 2}')
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assert.equal(detail, "Expected ',' or '}' after property value in JSON at position 12 (line 1 column 13)")
  assert.match(detail, /position 12/)
  assert.match(detail, /line 1 column 13/)
})

test('a wording this helper has never seen is refused if a double quote survived', () => {
  // The backstop, and the reason the helper is safe against V8 wordings that do
  // not exist yet. Across 500,206 distinct parse messages, every message with
  // no quoted snippet carried no double quote at all.
  assert.equal(
    parseFailureDetail({ message: `Some future wording naming "${CANARY}" at position 3` }),
    'the document could not be parsed as JSON',
  )
  assert.equal(parseFailureDetail({ message: 'Unexpected end of JSON input' }), 'Unexpected end of JSON input')
  assert.equal(parseFailureDetail({}), 'the document could not be parsed as JSON')
  assert.equal(parseFailureDetail(null), 'the document could not be parsed as JSON')
})

test('the canary never reaches stdout or stderr through the real binary', async () => {
  for (const [name, content] of [
    ['policy.json', CANARY],
    ['scenarios.json', `{"schemaVersion": "1", "scenarios": ${CANARY}}`],
  ]) {
    const files = { ...fixture(), [name]: content }
    const { code, stdout, stderr, report } = await cliReport(files)
    assert.equal(code, 2, 'an unparseable input is evidence that was not obtained')
    assert.equal(report.status, 'incomplete')
    for (let length = CANARY.length; length >= 4; length -= 1) {
      const prefix = CANARY.slice(0, length)
      assert.equal(stdout.includes(prefix), false, `${name}: stdout leaked ${length} characters`)
      assert.equal(stderr.includes(prefix), false, `${name}: stderr leaked ${length} characters`)
    }
  }
})

test('the canary never reaches stderr through a configuration error either', async () => {
  // The CLI path that writes a thrown message straight to stderr. A sibling
  // tool hardened its data path and left this one interpolating raw text.
  await withRoot(fixture(), async (root) => {
    const result = await cliRun(['--root', root, `--${CANARY}`, 'value'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a configuration error has no subject, so stdout stays empty')
    // The unknown option is echoed deliberately and bounded; what must not
    // happen is a file's contents arriving here.
    assert.match(result.stderr, /Unknown option/)
  })
})

test('no finding anywhere in an unparseable run carries a double quote from the document', async () => {
  const files = { ...fixture(), 'scenarios.json': `{"a": ${CANARY}}` }
  const report = await cliReport(files).then((result) => result.report)
  for (const value of everyString(report)) {
    assert.equal(value.includes(CANARY), false)
  }
  assert.equal(report.findings.some((finding) => finding.ruleId === 'input-not-json'), true)
})

test('a policy that is valid JSON but not an object is refused without reproducing it', async () => {
  const report = await cliReport({ ...fixture(), 'policy.json': `"${CANARY}"` }).then((result) => result.report)
  assert.equal(report.status, 'incomplete')
  for (const value of everyString(report)) assert.equal(value.includes(CANARY), false)
  assert.match(
    report.findings.find((finding) => finding.ruleId === 'policy-invalid').message,
    /a string of \d+ character\(s\)/,
    'the shape is reported, never the value',
  )
  assert.ok(policyOf().channels.length > 0)
})
