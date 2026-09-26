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

test('the human summary lists the findings, not only the counts', async () => {
  /**
   * The contract requires the CLI to provide a human-readable summary, and a
   * mutation that made `formatReport` loop over an empty array instead of
   * `report.findings` left the whole suite green: the counts still printed, so
   * nothing noticed that the findings had stopped. A person reading stderr is
   * reading the findings.
   */
  await withRoot(
    fixture(policyOf(), scenariosOf([scenario({ expect: { reportLabel: 'wrong', citationMode: 'required' } })])),
    async (root) => {
      const result = await cliRun(['--root', root])
      assert.equal(result.code, 1)
      const lines = result.stderr.split('\n')
      const emitted = JSON.parse(result.stdout).findings
      assert.ok(emitted.length >= 2, 'the fixture raises more than one finding')
      for (const finding of emitted) {
        assert.ok(
          lines.some((line) => line.includes(finding.ruleId) && line.includes(finding.severity.toUpperCase())),
          `the summary does not mention ${finding.ruleId}`,
        )
      }
      assert.ok(
        lines.some((line) => line.startsWith('ERROR') && line.includes('directive-mismatch')),
        'the severity leads the line so a reader can scan for it',
      )
    },
  )
})

test('a finding that has evidence carries it into the report', async () => {
  // Dropping the evidence field entirely left the suite green too. Evidence is
  // what tells a reader which request was refused, and the contract requires it
  // to be bounded and redacted rather than absent.
  const { report } = await cliReport(fixture())
  const refusal = report.findings.find((finding) => finding.ruleId === 'content-directive-refused')
  assert.ok(refusal !== undefined)
  assert.equal(typeof refusal.evidence, 'string')
  assert.match(refusal.evidence, /^request reportLabel refused: channel-is-content$/)
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
