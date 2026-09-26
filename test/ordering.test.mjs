import assert from 'node:assert/strict'
import test from 'node:test'

import { byCodeUnit, compareFindings } from '../src/index.mjs'
import { apiReport, cliReport, findingsFor, fixture, marker, policyOf, scenario, scenariosOf } from './support.mjs'

/**
 * Ordering, pinned by what the tool emits.
 *
 * A source scan for `.localeCompare(` is not a determinism test. `Intl.Collator`
 * collates identically and spells differently, so the scan passes while the
 * output silently starts depending on the ICU data of whichever Node build is
 * running -- and that has produced a real ordering difference in this catalog.
 *
 * Every case below uses inputs an English collator orders the other way round,
 * pushes them through the real report path, and asserts the exact emitted
 * order. The collator is constructed in each test and asserted to disagree,
 * which is what makes these cases cases at all. Substituting a collator under
 * any spelling fails a test here rather than going unnoticed.
 */

const collator = new Intl.Collator('en')

test('findings from two files are ordered by code unit, not by collation', async () => {
  assert.equal(collator.compare('Z-policy.json', 'a-scenarios.json') > 0, true, 'the disagreement being pinned')

  const { report } = await cliReport(
    { 'Z-policy.json': 'not json', 'a-other.json': 'unused' },
    ['--policy', 'Z-policy.json', '--scenarios', 'a-scenarios.json'],
  )

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    report.findings.map((finding) => finding.location.file),
    ['Z-policy.json', 'a-scenarios.json'],
    'Z (0x5A) precedes a (0x61) by code unit; an English collator puts a first',
  )
})

test('pointers are ordered by code unit, so two findings in one scenario keep a stable order', async () => {
  assert.equal(collator.compare('README', 'assets') > 0, true, 'the disagreement being pinned')

  const policy = policyOf({
    directives: [
      { name: 'README', default: 'baseline', settableBy: 'system' },
      { name: 'assets', default: 'baseline', settableBy: 'system' },
    ],
  })
  const report = await apiReport(fixture(policy, scenariosOf([scenario({
    segments: [
      { id: 'system-turn', channel: 'system', text: `${marker('README', 'one')} ${marker('assets', 'two')}` },
      { id: 'vendor-note', channel: 'retrieval', text: marker('README', 'vendor-preferred') },
    ],
    expect: { README: 'baseline', assets: 'baseline' },
    expectRefusals: [{ segment: 'vendor-note', directive: 'README', reason: 'channel-is-content' }],
  })])))

  assert.deepEqual(
    findingsFor(report, 'directive-mismatch').map((finding) => finding.location.pointer),
    ['/scenarios/0/expect/README', '/scenarios/0/expect/assets'],
  )
})

test('a hyphen sorts before an underscore, which collation treats as ignorable', async () => {
  assert.equal(collator.compare('a-b', 'a_b') > 0, true, 'collation orders these the other way round')
  assert.equal(byCodeUnit('a-b', 'a_b') < 0, true)

  const policy = policyOf({
    directives: [
      { name: 'a-b', default: 'baseline', settableBy: 'system' },
      { name: 'a_b', default: 'baseline', settableBy: 'system' },
    ],
  })
  const report = await apiReport(fixture(policy, scenariosOf([scenario({
    segments: [
      { id: 'system-turn', channel: 'system', text: `${marker('a-b', 'one')} ${marker('a_b', 'two')}` },
      { id: 'vendor-note', channel: 'retrieval', text: marker('a-b', 'vendor-preferred') },
    ],
    expect: { 'a-b': 'baseline', a_b: 'baseline' },
    expectRefusals: [{ segment: 'vendor-note', directive: 'a-b', reason: 'channel-is-content' }],
  })])))

  assert.deepEqual(
    findingsFor(report, 'directive-mismatch').map((finding) => finding.location.pointer),
    ['/scenarios/0/expect/a-b', '/scenarios/0/expect/a_b'],
  )
})

test('a list inside a message is ordered by code unit too', async () => {
  // Not just the finding order: the names joined into a sentence are sorted by
  // the same comparator, and a collator would reverse this pair.
  assert.equal(collator.compare('README', 'assets') > 0, true)

  const policy = policyOf({
    directives: [
      { name: 'README', default: 'baseline', settableBy: 'system' },
      { name: 'assets', default: 'baseline', settableBy: 'system' },
    ],
  })
  const report = await apiReport(fixture(policy, scenariosOf([scenario({ expect: {} })])))
  assert.match(findingsFor(report, 'expectation-incomplete')[0].message, /does not name README, assets,/)
})

test('the report is emitted in the documented order, not in the order it was produced', async () => {
  /**
   * `compareFindings` had a unit test; the report had none. Deleting
   * `.sort(compareFindings)` -- its only call site -- left the whole suite
   * green while stdout changed byte for byte, because every ordering fixture
   * happened to be produced in sorted order already. That is report-contract
   * defect class 7: an assertion that cannot fail is not a test.
   *
   * This fixture is produced in an order the sort has to change. Within one
   * scenario the refusal findings are emitted first, from
   * `/scenarios/N/segments/...`, and the scenario-level finding at
   * `/scenarios/N` is emitted after them -- so a shorter pointer that must sort
   * first arrives last. The scenario ids are chosen so the run also carries
   * findings whose only difference is the rule id.
   */
  const files = fixture(policyOf(), scenariosOf([
    scenario({
      id: 'zebra',
      segments: [
        { id: 'system-turn', channel: 'system', text: marker('reportLabel', 'baseline') },
        { id: 'vendor-note', channel: 'retrieval', text: marker('reportLabel', 'vendor-preferred') },
      ],
      expectRefusals: [],
    }),
    scenario({ id: 'apple' }),
  ]))

  const { report } = await cliReport(files)
  assert.deepEqual(
    report.findings.map((finding) => [finding.location.pointer, finding.ruleId]),
    [
      ['/scenarios/0', 'refusal-undeclared'],
      ['/scenarios/0/segments/1/text', 'content-directive-refused'],
      ['/scenarios/1/segments/1/text', 'content-directive-refused'],
    ],
    'the scenario-level finding is produced last and must be emitted first',
  )
})

test('a shorter pointer sorts before a longer one that extends it', async () => {
  // The pair the test above depends on, asserted directly so the intent
  // survives a fixture change: '/scenarios/0' precedes '/scenarios/0/segments'
  // by code unit because the shorter string is a prefix of the longer one.
  assert.ok(byCodeUnit('/scenarios/0', '/scenarios/0/segments/1/text') < 0)
  assert.ok(byCodeUnit('/scenarios/1/segments/1/text', '/scenarios/0') > 0)
})

test('two runs over identical inputs produce byte-identical stdout', async () => {
  const files = fixture(policyOf(), scenariosOf([
    scenario(),
    scenario({ id: 'Zebra-scenario' }),
    scenario({ id: 'apple-scenario' }),
  ]))
  const first = await cliReport(files)
  const second = await cliReport(files)
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
})

test('compareFindings is a total order over the documented key', () => {
  const finding = (file, pointer, ruleId, message, evidence) => ({
    location: { file, pointer }, ruleId, message, evidence,
  })
  assert.equal(compareFindings(finding('a', '', 'r', 'm', 'e'), finding('a', '', 'r', 'm', 'e')), 0)
  assert.ok(compareFindings(finding('Z', '', 'r', 'm'), finding('a', '', 'r', 'm')) < 0)
  assert.ok(compareFindings(finding('a', '/Z', 'r', 'm'), finding('a', '/a', 'r', 'm')) < 0)
  assert.ok(compareFindings(finding('a', '', 'A', 'm'), finding('a', '', 'a', 'm')) < 0)
  assert.ok(compareFindings(finding('a', '', 'r', 'Z'), finding('a', '', 'r', 'a')) < 0)
  assert.ok(compareFindings(finding('a', '', 'r', 'm', 'Z'), finding('a', '', 'r', 'm', 'a')) < 0)
  // The evidence key must tolerate a finding that has none.
  assert.ok(compareFindings(finding('a', '', 'r', 'm'), finding('a', '', 'r', 'm', 'a')) < 0)
})
