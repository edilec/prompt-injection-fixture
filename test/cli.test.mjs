import assert from 'node:assert/strict'
import test from 'node:test'

import { cliReport, cliRun, fixture, policyOf, scenario, scenariosOf, withRoot } from './support.mjs'

/**
 * The command-line surface.
 *
 * The two shapes of exit 2 are the part worth reading carefully: a
 * configuration error never had a subject, so stdout stays empty; an input that
 * could not be read did have one, so a consumer gets an `incomplete` report
 * naming the input it could not obtain.
 */

test('stdout carries the JSON report and nothing else', async () => {
  const { stdout, stderr, code } = await cliReport(fixture())
  assert.equal(code, 0)
  assert.doesNotThrow(() => JSON.parse(stdout))
  assert.equal(stdout.endsWith('}\n'), true)
  assert.equal(stderr, '', '--json suppresses the human summary')
})

test('without --json the human summary goes to stderr and stdout stays parseable', async () => {
  await withRoot(fixture(), async (root) => {
    const result = await cliRun(['--root', root])
    assert.equal(result.code, 0)
    const report = JSON.parse(result.stdout)
    assert.equal(report.tool, 'prompt-injection-fixture')
    assert.match(result.stderr, /^policy policy\.json: 1 scenario\(s\)/)
    assert.match(result.stderr, /status pass/)
  })
})

test('--help and --version exit 0 and write to stdout', async () => {
  const help = await cliRun(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /^prompt-injection-fixture\n/)
  assert.match(help.stdout, /Exit codes:/)
  assert.equal(help.stderr, '')

  const version = await cliRun(['--version'])
  assert.equal(version.code, 0)
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/)
})

test('an unknown option is a configuration error with empty stdout', async () => {
  const result = await cliRun(['--root', '.', '--nope'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option "--nope"/)
  assert.match(result.stderr, /Usage:/, 'the help follows the diagnostic')
})

test('a missing --root is a configuration error', async () => {
  const result = await cliRun([])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--root is required/)
})

test('a flag that needs a value and does not get one is refused', async () => {
  const result = await cliRun(['--root'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /--root requires a value/)
})

test('exit 1 means the run completed and contradicted what the scenario declared', async () => {
  const { code, report } = await cliReport(
    fixture(policyOf(), scenariosOf([scenario({ expect: { reportLabel: 'wrong', citationMode: 'required' } })])),
  )
  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.evaluated, 1, 'the scenario was evaluated; it just did not agree')
})

test('the incomplete note on stderr appears even with --json', async () => {
  await withRoot({ 'policy.json': policyOf() }, async (root) => {
    const result = await cliRun(['--root', root, '--json'])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /^incomplete: 0 of 0 scenario\(s\) were evaluated; this run is not a pass\.$/m)
    assert.equal(JSON.parse(result.stdout).status, 'incomplete')
  })
})

test('the report envelope is exactly the shape the contract describes', async () => {
  const { report } = await cliReport(fixture())
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'findings'])
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'prompt-injection-fixture')
  assert.ok(['pass', 'fail', 'incomplete'].includes(report.status))
  for (const key of ['checked', 'errors', 'warnings']) assert.equal(Number.isInteger(report.summary[key]), true, key)
  for (const finding of report.findings) {
    assert.deepEqual(
      Object.keys(finding).filter((key) => !['evidence', 'suggestion'].includes(key)),
      ['ruleId', 'severity', 'message', 'location'],
    )
    assert.deepEqual(Object.keys(finding.location), ['file', 'pointer'])
    assert.equal(finding.location.file.startsWith('/'), false, 'a location is never an absolute host path')
  }
})

test('a location is relative to the declared root even when the root is deep', async () => {
  await withRoot(fixture(), async (root) => {
    const result = await cliRun(['--root', root, '--json'])
    assert.equal(result.stdout.includes(root), false, 'the host path never reaches the report')
  })
})
