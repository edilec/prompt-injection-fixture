import assert from 'node:assert/strict'
import test from 'node:test'

import { excerpt, hasForbiddenCharacter } from '../src/index.mjs'
import { FORBIDDEN, cliReport, everyString, fixture, marker, policyOf, scenario, scenariosOf } from './support.mjs'

/**
 * Nothing untrusted carries a control, separator or bidi character into output.
 *
 * The report contract records four tools that stripped C0 and the line and
 * paragraph separators and let the C1 range through -- U+0085 is a line break
 * to a great many consumers and U+009B is the 8-bit CSI, which needs no ESC in
 * front of it -- and one tool that sanitised its evidence field carefully while
 * a page id containing a newline forged whole lines in the report.
 *
 * So each class is tested, and each is tested arriving through an identifier as
 * well as through text. In this tool the identifier route is real and easy to
 * miss: a scenario's `expect` object and a policy document can carry any JSON
 * key at all, and the key is named in the message that refuses it.
 */

for (const [name, character] of Object.entries(FORBIDDEN)) {
  test(`${name} arriving through a JSON key never reaches the report`, async () => {
    const { report } = await cliReport({
      ...fixture(),
      'scenarios.json': JSON.stringify({
        schemaVersion: '1',
        scenarios: [{ ...scenario(), expect: { [`report${character}Label`]: 'baseline' } }],
      }),
    })

    // A scenario that did not compile is a scenario nobody evaluated, so the
    // run is incomplete rather than merely failed.
    assert.equal(report.status, 'incomplete')
    for (const value of everyString(report)) {
      assert.equal(hasForbiddenCharacter(value), false, `${name} survived in ${JSON.stringify(value)}`)
    }
    assert.ok(report.findings.some((finding) => finding.ruleId === 'scenario-invalid'))
  })

  test(`${name} arriving through a policy key never reaches the report`, async () => {
    const { report } = await cliReport({
      ...fixture(),
      'policy.json': JSON.stringify({ ...policyOf(), [`extra${character}Key`]: 1 }),
    })
    assert.equal(report.status, 'incomplete')
    for (const value of everyString(report)) {
      assert.equal(hasForbiddenCharacter(value), false, `${name} survived in ${JSON.stringify(value)}`)
    }
  })
}

test('a directive value carrying a bidi override is refused rather than displayed', async () => {
  const RLO = FORBIDDEN['bidi RLO']
  const { report, code } = await cliReport({
    ...fixture(),
    'scenarios.json': JSON.stringify(scenariosOf([scenario({
      segments: [
        { id: 'system-turn', channel: 'system', text: marker('reportLabel', `base${RLO}line`) },
        { id: 'vendor-note', channel: 'retrieval', text: marker('reportLabel', 'vendor-preferred') },
      ],
    })])),
  })

  assert.notEqual(code, 0)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'directive-value-invalid'))
  for (const value of everyString(report)) assert.equal(hasForbiddenCharacter(value), false)
})

test('the human summary on stderr is sanitised too, not only the JSON on stdout', async () => {
  const NEL = FORBIDDEN['C1 NEL']
  const { stderr } = await cliReport({
    ...fixture(),
    'scenarios.json': JSON.stringify({
      schemaVersion: '1',
      scenarios: [{ ...scenario(), expect: { [`report${NEL}Label`]: 'baseline' } }],
    }),
  }, [])
  assert.equal(hasForbiddenCharacter(stderr.replaceAll('\n', '')), false)
})

test('a segment text is never echoed into the report at all', async () => {
  // The strongest version of "never echo an untrusted payload verbatim where it
  // could be mistaken for instructions": the text does not appear, in any form.
  const SENTENCE = 'ZZQ-distinctive-sentence-from-the-document'
  const { report } = await cliReport({
    ...fixture(),
    'scenarios.json': JSON.stringify(scenariosOf([scenario({
      segments: [
        { id: 'system-turn', channel: 'system', text: marker('reportLabel', 'baseline') },
        { id: 'vendor-note', channel: 'retrieval', text: `${SENTENCE} ${marker('reportLabel', 'vendor-preferred')}` },
      ],
    })])),
  })
  assert.equal(report.status, 'pass')
  for (const value of everyString(report)) assert.equal(value.includes(SENTENCE), false)
})

test('excerpt collapses whitespace, strips every class and bounds the result', () => {
  assert.equal(excerpt('  a\t\tb\n\nc  '), 'a b c')
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    assert.equal(hasForbiddenCharacter(excerpt(`a${character}b`)), false, name)
  }
  assert.equal(excerpt('x'.repeat(200)).length, 163, '160 characters plus the ellipsis')
  assert.equal(excerpt('x'.repeat(200)).endsWith('...'), true)
  assert.equal(excerpt('short', 3), 'sho...')
})
