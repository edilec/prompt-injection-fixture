import assert from 'node:assert/strict'
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { checkFixtures, renderedBanner } from '../src/index.mjs'
import { fixture, marker, policyOf, scenario, scenariosOf, withOutDirectory, withRoot } from './support.mjs'

/**
 * Rendering: the generated half of the tool.
 *
 * It is read-only by default and writes only where it was told to. The
 * overwrite guard is the part that matters: a generator that clobbers whatever
 * sits at the path it was pointed at eventually eats a hand-written file, and
 * "it was in the output directory" is not consent.
 */

async function render(files, body) {
  return withOutDirectory((out) => withRoot(files, async (root) => {
    const report = await checkFixtures({ root, out })
    return body({ report, out })
  }))
}

test('nothing is written when --out is not given', async () => {
  await withRoot(fixture(), async (root) => {
    const before = (await readdir(root)).sort()
    const report = await checkFixtures({ root })
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.rendered, 0)
    assert.deepEqual((await readdir(root)).sort(), before, 'the input tree is untouched')
  })
})

test('one file is written per scenario, named by its id', async () => {
  await render(fixture(policyOf(), scenariosOf([scenario(), scenario({ id: 'second' })])), async ({ report, out }) => {
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.rendered, 2)
    assert.deepEqual((await readdir(out)).sort(), [`${scenario().id}.fixture.txt`, 'second.fixture.txt'].sort())
  })
})

test('every rendered file starts with the banner that marks it as generated', async () => {
  await render(fixture(), async ({ out }) => {
    const text = await readFile(join(out, `${scenario().id}.fixture.txt`), 'utf8')
    assert.equal(text.startsWith(renderedBanner()), true)
    assert.match(renderedBanner(), /do not edit/)
  })
})

test('re-rendering over this tool\'s own output is allowed and byte-identical', async () => {
  await render(fixture(), async ({ out }) => {
    const first = await readFile(join(out, `${scenario().id}.fixture.txt`), 'utf8')
    await withRoot(fixture(), async (root) => {
      const report = await checkFixtures({ root, out })
      assert.equal(report.summary.rendered, 1)
    })
    const second = await readFile(join(out, `${scenario().id}.fixture.txt`), 'utf8')
    assert.equal(second, first, 'rendering reads no clock and no environment')
  })
})

test('a file this tool did not write is left alone and the run goes incomplete', async () => {
  await withOutDirectory(async (out) => {
    const target = join(out, `${scenario().id}.fixture.txt`)
    await writeFile(target, 'notes somebody wrote by hand\n')
    await withRoot(fixture(), async (root) => {
      const report = await checkFixtures({ root, out })
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.rendered, 0)
      assert.ok(report.findings.some((finding) => finding.ruleId === 'output-would-overwrite'))
    })
    assert.equal(await readFile(target, 'utf8'), 'notes somebody wrote by hand\n', 'the file is exactly as it was')
  })
})

test('a target that cannot be written is reported rather than thrown', async () => {
  // Read-only for the user running the suite. The destination is a regular
  // file this tool wrote, in the directory the caller named, so both guards
  // clear it and the failure is the open itself -- which is a finding, not a
  // refusal. A directory at the destination is a different thing entirely and
  // is refused; see test/destination.test.mjs.
  await withOutDirectory(async (out) => {
    const target = join(out, `${scenario().id}.fixture.txt`)
    await writeFile(target, `${renderedBanner()}\nrendered earlier\n`)
    await chmod(target, 0o444)
    await withRoot(fixture(), async (root) => {
      const report = await checkFixtures({ root, out })
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.rendered, 0)
      assert.ok(report.findings.some((finding) => finding.ruleId === 'output-unwritable'))
    })
    assert.equal(await readFile(target, 'utf8'), `${renderedBanner()}\nrendered earlier\n`)
  })
})
