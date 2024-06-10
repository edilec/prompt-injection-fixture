import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, compilePolicy, compileScenarios, runMockAgent, scanMarkers } from '../src/index.mjs'
import { marker, policyOf, scenario, scenariosOf } from './support.mjs'

/**
 * The mock agent's precedence semantics, tested directly.
 *
 * Precedence has two independent parts and a policy can get either wrong.
 * Authority is the trust boundary and does not depend on ordering at all;
 * order and the settableBy floor decide between instruction channels. Each is
 * pinned separately here, because a tool that collapses them reports a boundary
 * as holding when what actually held was an accident of who spoke first.
 */

const sink = { rows: [], add(row) { this.rows.push(row) } }

function agent(scenarios, policyDocument = policyOf(), limits = DEFAULT_LIMITS) {
  const rows = []
  const collecting = { add: (row) => rows.push(row) }
  const policy = compilePolicy(collecting, 'policy.json', policyDocument)
  assert.notEqual(policy, null, `the policy did not compile: ${JSON.stringify(rows)}`)
  const compiled = compileScenarios(collecting, 'scenarios.json', scenariosOf(scenarios), policy, limits)
  assert.notEqual(compiled, null, `the scenarios did not compile: ${JSON.stringify(rows)}`)
  assert.equal(compiled.scenarios.length, scenarios.length, `a scenario did not compile: ${JSON.stringify(rows)}`)
  return compiled.scenarios.map((one) => runMockAgent(policy, one, limits))
}

const resolved = (run, name) => run.state.get(name).value

test('a content channel never sets a directive, whatever it names', () => {
  const [run] = agent([scenario({
    segments: [
      { id: 'system-turn', channel: 'system', text: marker('reportLabel', 'baseline') },
      { id: 'note', channel: 'retrieval', text: `${marker('reportLabel', 'v')} ${marker('citationMode', 'off')} ${marker('unknownThing', 'x')}` },
    ],
    expectRefusals: [],
  })])

  assert.equal(resolved(run, 'reportLabel'), 'baseline')
  assert.equal(resolved(run, 'citationMode'), 'required')
  assert.deepEqual(run.refusals.map((refusal) => refusal.reason), ['channel-is-content', 'channel-is-content', 'channel-is-content'])
  assert.equal(run.applications.length, 1)
})

test('authority is checked before the directive is even looked up', () => {
  // A retrieved document asking for a directive nobody declared is a boundary
  // event, not a fixture typo. Reporting it as directive-unknown would put the
  // blame on the policy and lose the fact that content asked for something.
  const [run] = agent([scenario({
    segments: [{ id: 'note', channel: 'retrieval', text: marker('nothingDeclared', 'x') }],
    expectRefusals: [],
  })])
  assert.deepEqual(run.refusals.map((refusal) => refusal.reason), ['channel-is-content'])
})

test('an instruction channel below the floor is refused, and the floor is named', () => {
  const [run] = agent([scenario({
    segments: [{ id: 'user-turn', channel: 'user', text: marker('reportLabel', 'friendly') }],
    expectRefusals: [],
  })])
  assert.equal(resolved(run, 'reportLabel'), 'baseline')
  assert.deepEqual(run.refusals.map(({ reason, floor }) => ({ reason, floor })), [{ reason: 'channel-below-floor', floor: 'system' }])
})

test('an instruction channel at the floor sets the directive', () => {
  const [run] = agent([scenario({
    segments: [{ id: 'user-turn', channel: 'user', text: marker('citationMode', 'relaxed') }],
    expectRefusals: [],
  })])
  assert.equal(resolved(run, 'citationMode'), 'relaxed')
  assert.equal(run.refusals.length, 0)
})

test('a higher-precedence channel wins even when it spoke first', () => {
  const [run] = agent([scenario({
    segments: [
      { id: 'system-turn', channel: 'system', text: marker('citationMode', 'required') },
      { id: 'user-turn', channel: 'user', text: marker('citationMode', 'off') },
    ],
    expectRefusals: [],
  })])
  assert.equal(resolved(run, 'citationMode'), 'required')
  assert.deepEqual(run.refusals.map(({ reason, heldBy }) => ({ reason, heldBy })), [{ reason: 'lower-precedence', heldBy: 'system' }])
})

test('two assignments from the same channel resolve in document order, later last', () => {
  const [run] = agent([scenario({
    segments: [
      { id: 'first', channel: 'system', text: marker('reportLabel', 'one') },
      { id: 'second', channel: 'system', text: marker('reportLabel', 'two') },
    ],
    expectRefusals: [],
  })])
  assert.equal(resolved(run, 'reportLabel'), 'two')
  assert.equal(run.state.get('reportLabel').segment, 'second')
})

test('an unset directive keeps the policy default and records no owner', () => {
  const [run] = agent([scenario({
    segments: [{ id: 'note', channel: 'retrieval', text: 'nothing at all' }],
    expectRefusals: [],
  })])
  assert.equal(resolved(run, 'reportLabel'), 'baseline')
  assert.equal(run.state.get('reportLabel').segment, null)
  assert.equal(run.attempts, 0)
})

test('an unknown directive from an instruction channel is refused by name', () => {
  const [run] = agent([scenario({
    segments: [{ id: 'system-turn', channel: 'system', text: marker('nothingDeclared', 'x') }],
    expectRefusals: [],
  })])
  assert.deepEqual(run.refusals.map((refusal) => refusal.reason), ['directive-unknown'])
})

test('the marker scan is stateless between calls, including after one was truncated', () => {
  /**
   * A module-level global regular expression keeps `lastIndex` between calls,
   * so the next scan of the same text starts halfway through it.
   *
   * A completed scan hides this: `exec` returns null at the end and resets
   * `lastIndex` to zero on the way out. It is the scan that stops EARLY that
   * leaves the index parked, and that is exactly the scan a limit produces --
   * so the segment after a truncated one would be scanned from the wrong
   * offset, and the requests before that offset would be reported as absent.
   * The first assertion alone would not catch it, which is why the second is
   * here.
   */
  const text = `${marker('reportLabel', 'a')} and ${marker('citationMode', 'b')}`
  const first = scanMarkers(text, 64)
  const second = scanMarkers(text, 64)
  assert.deepEqual(first, second)
  assert.deepEqual(first.markers.map((one) => one.name), ['reportLabel', 'citationMode'])

  const truncated = scanMarkers(text, 1)
  assert.equal(truncated.truncated, true)
  const afterwards = scanMarkers(text, 64)
  assert.deepEqual(afterwards, first, 'a truncated scan must not move the next one along')
})

test('the marker syntax is exact: near misses are prose, not requests', () => {
  for (const text of [
    '[[SET reportLabel=x]]',
    '[[set reportLabel = x]]',
    '[[set 1reportLabel=x]]',
    '[[ set reportLabel=x ]]',
    '[set reportLabel=x]',
    `[[set reportLabel=${'x'.repeat(201)}]]`,
  ]) {
    assert.deepEqual(scanMarkers(text, 64).markers, [], text)
  }
  assert.equal(scanMarkers('[[set a.b-c_d=v]]', 64).markers.length, 1)
  assert.equal(sink.rows.length, 0)
})

test('the scan stops at the limit and says so rather than reporting what it did not see', () => {
  const text = `${marker('a', '1')} ${marker('b', '2')} ${marker('c', '3')}`
  const bounded = scanMarkers(text, 2)
  assert.equal(bounded.truncated, true)
  assert.equal(bounded.markers.length, 2)
  assert.equal(scanMarkers(text, 3).truncated, false)
})
