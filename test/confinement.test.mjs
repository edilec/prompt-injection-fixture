import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { checkFixtures, isInside } from '../src/index.mjs'
import { cliRun, everyString, policyOf, scenario, scenariosOf } from './support.mjs'

/**
 * Path confinement, tested against the thing that actually defeats it.
 *
 * Rejecting `..` and absolute paths is not confinement. A symbolic link planted
 * inside the declared root contains no `..` at all, and following one let
 * out-of-root content be echoed into a report elsewhere in this catalog. Here
 * the stakes are specific: the content this tool reads is content a person or
 * another agent will read afterwards.
 */

const OUTSIDE = 'ZZQ-content-from-outside-the-declared-root'

async function withTree(body) {
  const base = await mkdtemp(join(tmpdir(), 'prompt-injection-fixture-tree-'))
  try {
    const root = join(base, 'root')
    const elsewhere = join(base, 'elsewhere')
    await mkdir(root)
    await mkdir(elsewhere)
    await writeFile(join(root, 'policy.json'), JSON.stringify(policyOf()))
    await writeFile(join(elsewhere, 'secret.json'), JSON.stringify({
      schemaVersion: '1',
      scenarios: [scenario({ title: OUTSIDE })],
    }))
    return await body({ base, root, elsewhere })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('a symbolic link planted inside the root is refused unread', async () => {
  await withTree(async ({ root, elsewhere }) => {
    await symlink(join(elsewhere, 'secret.json'), join(root, 'scenarios.json'))
    const report = await checkFixtures({ root })

    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'path-escapes-root'))
    for (const value of everyString(report)) {
      assert.equal(value.includes(OUTSIDE), false, 'out-of-root content reached the report')
    }
  })
})

test('a symbolic link to a directory inside the root is refused as well', async () => {
  await withTree(async ({ root, elsewhere }) => {
    await symlink(elsewhere, join(root, 'linked'))
    const report = await checkFixtures({ root, scenarios: 'linked/secret.json' })
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'path-escapes-root'))
    for (const value of everyString(report)) assert.equal(value.includes(OUTSIDE), false)
  })
})

test('a missing file reached through a symlinked parent is refused, not reported as absent', async () => {
  // The interesting order: the entry does not exist, so realpath fails with
  // ENOENT before it can say anything about where the path pointed. Confining
  // the nearest existing ancestor is what stops a symlinked parent deciding
  // where a "missing" file would have been read from.
  await withTree(async ({ root, elsewhere }) => {
    await symlink(elsewhere, join(root, 'linked'))
    const report = await checkFixtures({ root, scenarios: 'linked/absent.json' })
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'path-escapes-root'))
  })
})

test('a relative path that steps out of the root is a configuration error with empty stdout', async () => {
  await withTree(async ({ root }) => {
    const result = await cliRun(['--root', root, '--scenarios', '../elsewhere/secret.json', '--json'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a configuration error never had a subject to report on')
    assert.match(result.stderr, /must not step outside --root/)
    assert.equal(result.stderr.includes(OUTSIDE), false)
  })
})

test('an absolute path is a configuration error too', async () => {
  await withTree(async ({ root, elsewhere }) => {
    const result = await cliRun(['--root', root, '--scenarios', join(elsewhere, 'secret.json'), '--json'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /must be relative to --root/)
  })
})

test('a root reached through a symbolic link is not falsely refused', async () => {
  // The other half of confinement, and the easier half to get wrong: comparing
  // a real root against an unresolved candidate refuses legitimate files
  // whenever the root itself is a link. On macOS a temporary directory usually
  // is one, which is how this defect hides.
  await withTree(async ({ base, root }) => {
    await writeFile(join(root, 'scenarios.json'), JSON.stringify(scenariosOf([scenario()])))
    const linkedRoot = join(base, 'linked-root')
    await symlink(root, linkedRoot)
    const report = await checkFixtures({ root: linkedRoot })
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.checked, 2)
  })
})

test('the output directory may not be inside the root, and the root may not be inside it', async () => {
  await withTree(async ({ base, root }) => {
    await writeFile(join(root, 'scenarios.json'), JSON.stringify(scenariosOf([scenario()])))
    const inside = join(root, 'rendered')
    await mkdir(inside)
    await assert.rejects(
      () => checkFixtures({ root, out: inside }),
      /--out must be outside --root/,
      'a generator that writes into the tree it reads will read its own output back',
    )
    await assert.rejects(() => checkFixtures({ root, out: base }), /--out must be outside --root/)
  })
})

test('isInside compares whole path segments, not string prefixes', () => {
  assert.equal(isInside('/a/b', '/a/b'), true)
  assert.equal(isInside('/a/b', '/a/b/c'), true)
  assert.equal(isInside('/a/b', '/a/bc'), false, 'a sibling whose name starts with the root name is not inside it')
  assert.equal(isInside('/a/b/', '/a/b/c'), true)
})

test('a root that is not a directory is a configuration error', async () => {
  await withTree(async ({ root }) => {
    await assert.rejects(() => checkFixtures({ root: join(root, 'policy.json') }), /--root must be a directory/)
    await assert.rejects(() => checkFixtures({ root: join(root, 'absent') }), /--root could not be resolved/)
  })
})
