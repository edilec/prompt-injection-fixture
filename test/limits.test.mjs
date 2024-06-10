import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, HARD_LIMITS, checkFixtures, validateLimits } from '../src/index.mjs'
import { apiReport, cliReport, cliRun, findingsFor, fixture, marker, policyOf, raisedRules, scenario, scenariosOf, withRoot } from './support.mjs'

/**
 * Every documented limit is enforced, reported by name, and reachable from the
 * command line.
 *
 * A configuration key that is accepted and silently ignored is a limit nobody
 * enforces -- one tool in this catalog documented a time budget the CLI never
 * wired through. So each limit is driven from argv, not only from the API, and
 * an unknown key is refused rather than dropped.
 */

test('every default limit has a hard cap and a command-line flag', async () => {
  const documented = Object.keys(DEFAULT_LIMITS).sort()
  assert.deepEqual(Object.keys(HARD_LIMITS).sort(), documented)
  for (const key of documented) assert.ok(HARD_LIMITS[key] >= DEFAULT_LIMITS[key], key)

  const help = (await cliRun(['--help'])).stdout
  const flags = {
    maxFileBytes: '--max-file-bytes',
    maxFindings: '--max-findings',
    maxMarkersPerSegment: '--max-markers-per-segment',
    maxScenarios: '--max-scenarios',
    maxSegmentChars: '--max-segment-chars',
    maxSegments: '--max-segments',
  }
  assert.deepEqual(Object.keys(flags).sort(), documented)
  for (const [key, flag] of Object.entries(flags)) {
    assert.ok(help.includes(flag), `${flag} is not in --help`)
    assert.ok(help.includes(String(DEFAULT_LIMITS[key])), `the default for ${key} is not in --help`)
  }
})

test('an unknown limit key is refused rather than ignored', () => {
  assert.throws(() => validateLimits({ maxSegment: 5 }), /Unknown limit "maxSegment"/)
  assert.throws(() => validateLimits({ maxSegment: 5 }), /known limits are maxFileBytes, maxFindings/)
  assert.throws(() => validateLimits('nope'), /limits must be an object/)
})

test('a limit outside its range is refused', () => {
  assert.throws(() => validateLimits({ maxScenarios: 0 }), /between 1 and 5000/)
  assert.throws(() => validateLimits({ maxScenarios: 1.5 }), /between 1 and 5000/)
  assert.throws(() => validateLimits({ maxScenarios: HARD_LIMITS.maxScenarios + 1 }), /between 1 and 5000/)
  assert.deepEqual(validateLimits({ maxScenarios: 7 }).maxScenarios, 7)
  assert.deepEqual(validateLimits(), DEFAULT_LIMITS)
})

test('an unknown option to the API is refused rather than ignored', async () => {
  await assert.rejects(() => checkFixtures({ root: '.', scenario: 'typo.json' }), /Unknown option "scenario"/)
  await assert.rejects(() => checkFixtures('nope'), /options must be an object/)
  await assert.rejects(() => checkFixtures({}), /root must be a non-empty string/)
})

test('maxFileBytes stops the read and names itself', async () => {
  const report = await apiReport(fixture(), { limits: { maxFileBytes: 8 } })
  assert.equal(report.status, 'incomplete')
  assert.equal(findingsFor(report, 'input-too-large').length, 2, 'both inputs are bounded, not only the big one')
  assert.match(findingsFor(report, 'input-too-large')[0].message, /maxFileBytes limit of 8/)
})

test('maxScenarios stops the walk and names itself', async () => {
  const { code, report } = await cliReport(
    fixture(policyOf(), scenariosOf([scenario(), scenario({ id: 'second' }), scenario({ id: 'third' })])),
    ['--max-scenarios', '2'],
  )
  assert.equal(code, 2)
  assert.equal(report.summary.scenarios, 2)
  assert.match(findingsFor(report, 'too-many-scenarios')[0].message, /maxScenarios limit of 2/)
})

test('maxSegments is a budget across the whole file, not per scenario', async () => {
  const { report } = await cliReport(
    fixture(policyOf(), scenariosOf([scenario(), scenario({ id: 'second' })])),
    ['--max-segments', '3'],
  )
  assert.equal(report.status, 'incomplete')
  assert.match(findingsFor(report, 'too-many-segments')[0].message, /maxSegments limit of 3/)
  assert.equal(report.summary.scenarios, 1, 'the scenario that ran out of budget was not compiled')
})

test('maxSegmentChars leaves the oversize segment unscanned and the scenario unevaluated', async () => {
  const report = await apiReport(fixture(), { limits: { maxSegmentChars: 40 } })
  assert.equal(report.status, 'incomplete')
  assert.ok(raisedRules(report).includes('segment-text-too-large'))
  assert.ok(raisedRules(report).includes('expectation-unevaluated'))
  assert.match(findingsFor(report, 'segment-text-too-large')[0].message, /maxSegmentChars limit of 40/)
})

test('maxMarkersPerSegment bounds the scan and names itself', async () => {
  const report = await apiReport(
    fixture(policyOf(), scenariosOf([scenario({
      segments: [
        { id: 'system-turn', channel: 'system', text: `${marker('reportLabel', 'baseline')} ${marker('citationMode', 'required')}` },
        { id: 'vendor-note', channel: 'retrieval', text: marker('reportLabel', 'vendor-preferred') },
      ],
    })])),
    { limits: { maxMarkersPerSegment: 1 } },
  )
  assert.equal(report.status, 'incomplete')
  assert.match(findingsFor(report, 'too-many-markers')[0].message, /maxMarkersPerSegment limit of 1/)
})

test('maxFindings truncates deterministically and says how many were dropped', async () => {
  const files = fixture(policyOf(), scenariosOf([
    scenario(),
    scenario({ id: 'second' }),
    scenario({ id: 'third' }),
  ]))
  const report = await apiReport(files, { limits: { maxFindings: 2 } })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.length, 2)
  assert.match(findingsFor(report, 'too-many-findings')[0].message, /2 were not reported/)

  const again = await apiReport(files, { limits: { maxFindings: 2 } })
  assert.deepEqual(again.findings, report.findings, 'truncation is not order-dependent')
})

test('a repeated flag is a configuration error, not a silent last-wins', async () => {
  await withRoot(fixture(), async (root) => {
    const result = await cliRun(['--root', root, '--max-scenarios', '5', '--max-scenarios', '50'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--max-scenarios was given more than once/)
  })
})

test('a limit flag that is not a positive integer is refused', async () => {
  await withRoot(fixture(), async (root) => {
    for (const value of ['0', '-1', '1.5', 'many']) {
      const result = await cliRun(['--root', root, '--max-scenarios', value])
      assert.equal(result.code, 2, value)
      assert.match(result.stderr, /--max-scenarios requires a positive integer|--max-scenarios requires a value/)
    }
  })
})
