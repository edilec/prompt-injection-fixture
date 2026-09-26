import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { cliRun, projectDirectory } from './support.mjs'

/**
 * The shipped examples, run as a user would run them.
 *
 * An example in a README that nobody executes is a claim, not a demonstration.
 * Both of these are driven through the real binary, and the difference between
 * them is one edit to the policy file -- which is the point being made.
 */

const example = (name) => join(projectDirectory, 'examples', name)

test('the clean example exits 0 and refuses every content request', async () => {
  const result = await cliRun(['--root', example('clean'), '--json'])
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(result.stdout)

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.scenarios, 4)
  assert.equal(report.summary.evaluated, 4)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.ok(report.summary.challenges >= 4, 'each scenario actually exercises the boundary')
  assert.deepEqual(
    [...new Set(report.findings.map((finding) => finding.severity))],
    ['info'],
    'a clean run reports observations only',
  )
})

test('the broken example exits 1 and names the policy change', async () => {
  const result = await cliRun(['--root', example('broken'), '--json'])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)

  assert.equal(report.status, 'fail')
  const raised = new Set(report.findings.map((finding) => finding.ruleId))
  for (const ruleId of ['precedence-violated', 'directive-mismatch', 'refusal-reason-mismatch']) {
    assert.ok(raised.has(ruleId), `the broken example no longer demonstrates ${ruleId}`)
  }
  assert.equal(report.summary.scenarios, 4, 'the same four fixtures, judged against the other policy')
  assert.equal(report.summary.evaluated, 4, 'every scenario was evaluated; they disagreed with what they declared')
  assert.ok(report.summary.contentSegments > 0, 'the tool and quoted channels are still content, so the suite still challenges')
})

test('the two examples differ only in the policy, which is what makes the point', async () => {
  /**
   * The claim in the README and the CHANGELOG is "one edit to the trust
   * configuration, no edit to the fixture at all". The shipped pair did not
   * hold it -- the two scenario files declared different scenarios with
   * different text -- so the claim was carried by a unit test while the
   * artifact a reader diffs said something else. The files are now the same
   * bytes, and this asserts that rather than asserting one shared entry.
   */
  const cleanPolicy = JSON.parse(await readFile(example('clean/policy.json'), 'utf8'))
  const brokenPolicy = JSON.parse(await readFile(example('broken/policy.json'), 'utf8'))

  const authority = (policy) => Object.fromEntries(policy.channels.map((channel) => [channel.name, channel.authority]))
  assert.equal(authority(cleanPolicy).retrieval, 'content')
  assert.equal(authority(brokenPolicy).retrieval, 'instruction')
  assert.notDeepEqual(cleanPolicy, brokenPolicy, 'the policy is the edit')

  const cleanScenarios = await readFile(example('clean/scenarios.json'), 'utf8')
  const brokenScenarios = await readFile(example('broken/scenarios.json'), 'utf8')
  assert.equal(brokenScenarios, cleanScenarios, 'the fixtures are byte-for-byte the same file in both runs')
})

test('the README quick start commands are the ones that exist', async () => {
  const readme = await readFile(join(projectDirectory, 'README.md'), 'utf8')
  for (const command of [
    'node bin/prompt-injection-fixture.mjs --root examples/clean',
    'node bin/prompt-injection-fixture.mjs --root examples/broken',
    'node bin/prompt-injection-fixture.mjs --root examples/clean --out /tmp/fixtures',
  ]) {
    assert.ok(readme.includes(command), `the README no longer shows: ${command}`)
  }
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))
  assert.match(manifest.scripts.example, /--root examples\/clean/)
  assert.match(manifest.scripts['example:broken'], /--root examples\/broken/)
  assert.match(manifest.scripts.check, /example:broken/)
})
