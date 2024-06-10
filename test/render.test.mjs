import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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
  await withOutDirectory(async (out) => {
    await mkdir(join(out, `${scenario().id}.fixture.txt`))
    await withRoot(fixture(), async (root) => {
      const report = await checkFixtures({ root, out })
      assert.equal(report.status, 'incomplete')
      assert.ok(report.findings.some((finding) => finding.ruleId === 'output-unwritable'))
    })
  })
})

test('a scenario whose text was too large to scan is not rendered', async () => {
  // Rendering a fixture nobody could evaluate would put a file on disk that
  // looks checked and is not.
  await withOutDirectory(async (out) => {
    await withRoot(fixture(), async (root) => {
      const report = await checkFixtures({ root, out, limits: { maxSegmentChars: 10 } })
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.rendered, 0)
    })
    assert.deepEqual(await readdir(out), [])
  })
})

test('content is wrapped and instruction text is not, and the labels name both channel and segment', async () => {
  const both = scenario({
    segments: [
      { id: 'system-turn', channel: 'system', text: `${marker('reportLabel', 'baseline')}` },
      { id: 'note', channel: 'retrieval', source: 'index/note.md', text: marker('reportLabel', 'vendor-preferred') },
      { id: 'result', channel: 'tool', text: 'a tool result with no request in it' },
    ],
    expectRefusals: [{ segment: 'note', directive: 'reportLabel', reason: 'channel-is-content' }],
  })

  await render(fixture(policyOf(), scenariosOf([both])), async ({ out }) => {
    const text = await readFile(join(out, `${both.id}.fixture.txt`), 'utf8')
    assert.match(text, /\[system\] \(instruction, segment system-turn\)/)
    assert.match(text, /# source: index\/note\.md/)
    assert.match(text, /<untrusted-content channel="retrieval" segment="note">/)
    assert.match(text, /<untrusted-content channel="tool" segment="result">/)
    assert.equal((text.match(/<\/untrusted-content>/g) ?? []).length, 2, 'each content segment is closed')
    assert.equal(text.includes('<untrusted-content channel="system"'), false, 'instruction text is not labelled as content')
  })
})
