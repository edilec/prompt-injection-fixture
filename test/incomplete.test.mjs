import assert from 'node:assert/strict'
import test from 'node:test'

import { cliReport, findingsFor, fixture, marker, policyOf, raisedRules, scenario, scenariosOf } from './support.mjs'

/**
 * Evidence the tool did not obtain never satisfies a check.
 *
 * Every case here asserts three things together: the status is `incomplete`,
 * the process exits 2, and no finding claims the boundary held. The exit code
 * is the part a coordinated edit of the source cannot satisfy -- and it is the
 * part that distinguishes "we could not tell" from "we checked and it failed",
 * which is the distinction a consumer piping stdout actually acts on.
 */

async function expectIncomplete(files, args = []) {
  const { code, report, stdout } = await cliReport(files, args)
  assert.notEqual(stdout, '', 'a run with a subject always writes a report, so the consumer learns which input failed')
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.notEqual(report.status, 'pass')
  return report
}

test('an input that could not be read reports incomplete on stdout and exits 2', async () => {
  const report = await expectIncomplete({ 'policy.json': policyOf() })
  assert.deepEqual(raisedRules(report), ['input-unreadable'])
  assert.match(findingsFor(report, 'input-unreadable')[0].message, /ENOENT/)
})

test('an input that is not UTF-8 is decided by the decoder, not by the decoded text', async () => {
  // A replacement character in the decoded text is not evidence either way: a
  // file may legitimately contain one. Strict decoding is the only answer, and
  // inferring it from content is what let an unread input report a pass in this
  // catalog.
  const report = await expectIncomplete({
    ...fixture(),
    'scenarios.json': new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]),
  })
  assert.ok(report.findings.some((finding) => finding.ruleId === 'input-not-utf8'))
})

test('a file that legitimately contains a replacement character is still checked', async () => {
  const { code, report } = await cliReport(fixture(policyOf(), scenariosOf([scenario({
    segments: [
      { id: 'system-turn', channel: 'system', text: `${String.fromCharCode(0xfffd)} ${marker('reportLabel', 'baseline')}` },
      { id: 'vendor-note', channel: 'retrieval', text: marker('reportLabel', 'vendor-preferred') },
    ],
  })])))
  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
})

test('an empty scenario list is refused rather than passing on no evidence', async () => {
  const report = await expectIncomplete(fixture(policyOf(), scenariosOf([])))
  assert.deepEqual(raisedRules(report), ['no-scenarios'])
  assert.equal(report.summary.checked, 0)
})

test('a run in which nothing could be scanned is refused rather than passing on no evidence', async () => {
  const report = await expectIncomplete(fixture(), ['--max-segment-chars', '1'])
  assert.ok(raisedRules(report).includes('no-segments-evaluated'))
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.evaluated, 0)
})

test('a scan stopped by a limit never leaves a declared refusal looking satisfied', async () => {
  /**
   * The defect class this case exists for. The challenge is the SECOND marker
   * in the document, so a scan bounded at one marker never reaches it. What
   * must not happen is the expectation quietly counting as met -- and equally,
   * what must not happen is `challenge-absent`, which would assert the document
   * no longer carries the request when nobody looked.
   */
  const files = fixture(policyOf(), scenariosOf([scenario({
    segments: [
      { id: 'system-turn', channel: 'system', text: marker('reportLabel', 'baseline') },
      {
        id: 'vendor-note',
        channel: 'retrieval',
        text: `${marker('citationMode', 'off')} and then ${marker('reportLabel', 'vendor-preferred')}`,
      },
    ],
    expectRefusals: [
      { segment: 'vendor-note', directive: 'citationMode', reason: 'channel-is-content' },
      { segment: 'vendor-note', directive: 'reportLabel', reason: 'channel-is-content' },
    ],
  })]))

  const report = await expectIncomplete(files, ['--max-markers-per-segment', '1'])
  assert.ok(raisedRules(report).includes('too-many-markers'))
  assert.ok(raisedRules(report).includes('expectation-unevaluated'))
  assert.equal(raisedRules(report).includes('challenge-absent'), false, 'nobody looked, so nothing may be reported as absent')
  assert.equal(report.summary.evaluated, 0, 'the scenario was not evaluated')

  // And the same fixture with the limit raised is a pass, which is what makes
  // the case above a case rather than a broken fixture.
  const { code, report: full } = await cliReport(files)
  assert.equal(code, 0)
  assert.equal(full.status, 'pass')
  assert.equal(full.summary.challenges, 2)
})

test('a scenario that did not compile leaves the run incomplete, not merely failed', async () => {
  const report = await expectIncomplete(fixture(policyOf(), scenariosOf([
    scenario(),
    { id: 'broken', segments: 'not an array', expect: {} },
  ])))
  assert.ok(raisedRules(report).includes('scenario-invalid'))
  assert.equal(report.summary.scenarios, 1, 'one scenario compiled')
})

test('a policy that did not compile means no scenario was evaluated', async () => {
  const report = await expectIncomplete(fixture(policyOf({ schemaVersion: '9' })))
  assert.deepEqual(raisedRules(report), ['policy-invalid'])
  assert.equal(report.summary.scenarios, 0)
  assert.equal(report.summary.checked, 0)
})

test('a rendered fixture that could not be written leaves the run incomplete', async () => {
  // Rendering is part of the job when --out is given, so a scenario that was
  // checked but not written is a job half done, and the report says so.
  const { code, report } = await cliReport(fixture(), [])
  assert.equal(code, 0)
  assert.equal(report.summary.rendered, 0, 'without --out the run is read-only')
})

test('truncating the findings list makes the report incomplete rather than quietly partial', async () => {
  const report = await expectIncomplete(
    fixture(policyOf(), scenariosOf([scenario(), scenario({ id: 'second' })])),
    ['--max-findings', '1'],
  )
  assert.ok(raisedRules(report).includes('too-many-findings'))
  assert.equal(report.findings.length, 1)
})
