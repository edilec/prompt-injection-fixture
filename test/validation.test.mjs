import assert from 'node:assert/strict'
import test from 'node:test'

import { apiReport, findingsFor, fixture, marker, policyOf, raisedRules, scenario, scenariosOf } from './support.mjs'

/**
 * What the two input documents must look like, and what happens when they do
 * not.
 *
 * The recurring principle: an unknown key is refused rather than ignored. A key
 * this tool silently drops is a setting somebody believes is being enforced,
 * and a one-character typo in `settableBy` or `authority` would turn a real
 * failure into a green run.
 */

const only = (report, ...rules) => assert.deepEqual(raisedRules(report), rules.sort())

test('a policy with an unknown key is refused, and the key is named', async () => {
  const report = await apiReport(fixture(policyOf({ chanels: [] })))
  only(report, 'policy-invalid')
  assert.match(findingsFor(report, 'policy-invalid')[0].message, /it also declares chanels/)
})

test('a channel with an unknown key is refused', async () => {
  const policy = policyOf()
  policy.channels[0] = { name: 'system', authority: 'instruction', trusted: true }
  const report = await apiReport(fixture(policy))
  only(report, 'policy-channel-invalid')
  assert.match(findingsFor(report, 'policy-channel-invalid')[0].message, /also declares trusted/)
})

test('a channel authority outside the two the policy knows is refused', async () => {
  const policy = policyOf()
  policy.channels[0] = { name: 'system', authority: 'trusted' }
  const report = await apiReport(fixture(policy))
  only(report, 'policy-channel-invalid')
  assert.match(findingsFor(report, 'policy-channel-invalid')[0].message, /one of content, instruction/)
})

test('a duplicate channel is refused because its precedence would be ambiguous', async () => {
  const policy = policyOf()
  policy.channels.push({ name: 'system', authority: 'content' })
  const report = await apiReport(fixture(policy))
  only(report, 'policy-channel-invalid')
  assert.match(findingsFor(report, 'policy-channel-invalid')[0].message, /declared more than once/)
})

test('a policy with no content channel is refused: the boundary is not in it', async () => {
  const policy = policyOf({ channels: [{ name: 'system', authority: 'instruction' }] })
  const report = await apiReport(fixture(policy))
  only(report, 'policy-invalid')
  assert.match(findingsFor(report, 'policy-invalid')[0].message, /the trust boundary this tool exists to exercise is not in the policy/)
})

test('a policy with no instruction channel is refused: nothing could ever be set', async () => {
  const policy = policyOf({ channels: [{ name: 'retrieval', authority: 'content' }] })
  const report = await apiReport(fixture(policy))
  only(report, 'policy-invalid')
  assert.match(findingsFor(report, 'policy-invalid')[0].message, /no directive could ever be set/)
})

test('a directive whose floor is a content channel is refused as a contradiction', async () => {
  const policy = policyOf()
  policy.directives[0].settableBy = 'tool'
  const report = await apiReport(fixture(policy))
  only(report, 'policy-directive-invalid')
  assert.match(findingsFor(report, 'policy-directive-invalid')[0].message, /a content channel/)
})

test('a directive with no default is refused rather than defaulting to nothing', async () => {
  const policy = policyOf()
  delete policy.directives[0].default
  const report = await apiReport(fixture(policy))
  only(report, 'policy-directive-invalid')
  assert.match(findingsFor(report, 'policy-directive-invalid')[0].message, /must declare a default/)
})

test('an envelope that does not name the channel is refused, not rendered', async () => {
  const report = await apiReport(fixture(policyOf({ envelope: { open: '<untrusted segment="{id}">', close: '</untrusted>' } })))
  only(report, 'envelope-unlabeled')
  assert.match(findingsFor(report, 'envelope-unlabeled')[0].message, /must interpolate \{channel\}/)
})

test('an envelope close marker with a placeholder in it is refused', async () => {
  const report = await apiReport(fixture(policyOf({
    envelope: { open: '<u c="{channel}" s="{id}">', close: '</u {id}>' },
  })))
  only(report, 'policy-invalid')
  assert.match(findingsFor(report, 'policy-invalid')[0].message, /must be a fixed marker with no placeholders/)
})

test('a scenario id that could name a path is refused', async () => {
  for (const id of ['has/a/separator', '.hidden', '..', 'x'.repeat(101)]) {
    const report = await apiReport(fixture(policyOf(), scenariosOf([scenario({ id })])))
    assert.ok(raisedRules(report).includes('scenario-invalid'), id)
  }
})

test('a segment naming a channel the policy does not declare is refused, never assumed to be content', async () => {
  const report = await apiReport(fixture(policyOf(), scenariosOf([scenario({
    segments: [{ id: 'note', channel: 'rag', text: marker('reportLabel', 'x') }],
    expectRefusals: [],
  })])))
  assert.ok(raisedRules(report).includes('channel-unknown'))
  assert.match(findingsFor(report, 'channel-unknown')[0].message, /its authority is unknown/)
})

test('an expectation that does not name every declared directive is refused', async () => {
  const report = await apiReport(fixture(policyOf(), scenariosOf([scenario({ expect: { reportLabel: 'baseline' } })])))
  assert.ok(raisedRules(report).includes('expectation-incomplete'))
  assert.match(findingsFor(report, 'expectation-incomplete')[0].message, /does not name citationMode/)
})

test('an expectRefusals entry must name a segment in its own scenario', async () => {
  const report = await apiReport(fixture(policyOf(), scenariosOf([scenario({
    expectRefusals: [{ segment: 'not-here', directive: 'reportLabel' }],
  })])))
  assert.ok(raisedRules(report).includes('scenario-invalid'))
  assert.match(findingsFor(report, 'scenario-invalid')[0].message, /names a segment that is not in this scenario/)
})

test('an expectRefusals reason outside the four the agent can produce is refused', async () => {
  const report = await apiReport(fixture(policyOf(), scenariosOf([scenario({
    expectRefusals: [{ segment: 'vendor-note', directive: 'reportLabel', reason: 'untrusted' }],
  })])))
  assert.ok(raisedRules(report).includes('scenario-invalid'))
  assert.match(
    findingsFor(report, 'scenario-invalid')[0].message,
    /not one of channel-below-floor, channel-is-content, directive-unknown, lower-precedence/,
  )
})

test('an expectation with no declared reason is satisfied by any refusal, and says so in the docs', async () => {
  // Deliberate: a scenario may care only that the request did not apply. The
  // reason field is how a scenario says it cares which guard held.
  const report = await apiReport(fixture(policyOf(), scenariosOf([scenario({
    expectRefusals: [{ segment: 'vendor-note', directive: 'reportLabel' }],
  })])))
  assert.equal(report.status, 'pass')
})

test('a duplicate segment id inside one scenario is refused', async () => {
  const report = await apiReport(fixture(policyOf(), scenariosOf([scenario({
    segments: [
      { id: 'same', channel: 'system', text: marker('reportLabel', 'baseline') },
      { id: 'same', channel: 'retrieval', text: marker('reportLabel', 'v') },
    ],
    expectRefusals: [],
  })])))
  assert.ok(raisedRules(report).includes('segment-duplicate'))
})

test('a duplicate scenario id is refused because a rendered fixture would overwrite the earlier one', async () => {
  const report = await apiReport(fixture(policyOf(), scenariosOf([scenario(), scenario()])))
  assert.ok(raisedRules(report).includes('scenario-duplicate'))
  assert.equal(report.summary.scenarios, 1)
})
