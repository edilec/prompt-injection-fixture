import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DestinationError, assertWritableDestination } from '../src/destination.mjs'
import { renderedBanner } from '../src/index.mjs'
import { CLI, cliRun, fixture, policyOf, scenario, scenariosOf } from './support.mjs'

/**
 * The write guard, with one case per hole and one per legitimate destination.
 *
 * This tool shipped all three holes open. A symbolic link planted in `--out`
 * sent a rendered fixture to a file outside the directory, destroyed it, and
 * the run reported `pass` and exited 0 -- and the banner check that was
 * supposed to protect the file did the opposite: the victim's first line
 * happened to be this tool's own banner, so the guard read it as this tool's
 * own output and cleared the write.
 *
 * The allowed cases are not optional. A guard that refuses every destination
 * passes every data-loss test above while making `--out` useless, so the same
 * file has to hold both halves.
 */

const BANNER_LINE = `${renderedBanner()}\n`
const KEPT = 'NOTES-THE-USER-KEPT-HERE\n'
const targetName = `${scenario().id}.fixture.txt`

/**
 * A root holding a valid pair of inputs, an output directory beside it, and a
 * third directory that is neither -- the place a planted link points at.
 */
async function withTree(body) {
  const base = await mkdtemp(join(tmpdir(), 'prompt-injection-fixture-dest-'))
  try {
    const root = join(base, 'root')
    const out = join(base, 'out')
    const elsewhere = join(base, 'elsewhere')
    for (const directory of [root, out, elsewhere]) await mkdir(directory)
    for (const [name, content] of Object.entries(fixture())) {
      await writeFile(join(root, name), `${JSON.stringify(content, null, 2)}\n`)
    }
    return await body({ base, root, out, elsewhere })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

const run = (root, out) => cliRun(['--root', root, '--out', out, '--json'])

test('hole 1: a symbolic link at the destination is refused, and the file it points at survives', async () => {
  await withTree(async ({ root, out, elsewhere }) => {
    // The victim starts with this tool's own banner, which is what made the
    // overwrite guard clear the write: it recognised its own output in a file
    // it had never written.
    const victim = join(elsewhere, 'notes.txt')
    await writeFile(victim, BANNER_LINE + KEPT)
    await symlink(victim, join(out, targetName))

    const result = await run(root, out)
    assert.equal(result.code, 2, result.stderr)
    assert.equal(result.stdout, '', 'a refused destination is a configuration error, so stdout stays empty')
    assert.match(result.stderr, /symbolic link/)
    assert.equal(await readFile(victim, 'utf8'), BANNER_LINE + KEPT, 'the file outside --out is untouched')
  })
})

test('hole 1b: a dangling link creates nothing where it points', async () => {
  await withTree(async ({ root, out, elsewhere }) => {
    await symlink(join(elsewhere, 'created-outside.txt'), join(out, targetName))

    const result = await run(root, out)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.deepEqual(await readdir(elsewhere), [], 'nothing was created outside --out')
  })
})

test('hole 2: a symlinked output directory is refused before it is resolved', async () => {
  await withTree(async ({ base, root, elsewhere }) => {
    await writeFile(join(elsewhere, 'notes.txt'), KEPT)
    const linked = join(base, 'linked-out')
    await symlink(elsewhere, linked)

    const result = await run(root, linked)
    assert.equal(result.code, 2, result.stderr)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--out is a symbolic link/)
    assert.deepEqual(await readdir(elsewhere), ['notes.txt'], 'no fixture was deposited through the link')
  })
})

test('hole 2b: a resolved parent outside the root is refused by the guard itself', async () => {
  // The lexical check a tool usually writes passes here: `out/link/x` has no
  // ".." in it and starts with the root. Only resolving the parent sees it.
  await withTree(async ({ out, elsewhere }) => {
    await symlink(elsewhere, join(out, 'link'))
    await assert.rejects(
      () => assertWritableDestination(join(out, 'link', 'x.txt'), { root: out }),
      (error) => error instanceof DestinationError && /outside the permitted root/.test(error.message),
    )
  })
})

test('hole 3: a hard link to an input is refused, and the input survives', async () => {
  // No target to resolve and no shared path, so realpath and string comparison
  // both call it a different file. It is the same file; only dev plus ino sees
  // that. This hole recurred in three tools after it was written down.
  await withTree(async ({ root, out }) => {
    const policy = join(root, 'policy.json')
    const before = await readFile(policy, 'utf8')
    await link(policy, join(out, targetName))

    const result = await run(root, out)
    assert.equal(result.code, 2, result.stderr)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /same file as an input/)
    assert.equal(await readFile(policy, 'utf8'), before, 'the input this run read is byte-identical')
  })
})

test('a lexical ".." in the destination is refused too', async () => {
  await withTree(async ({ base, out }) => {
    await assert.rejects(
      () => assertWritableDestination(join(out, '..', 'escaped.txt'), { root: out }),
      DestinationError,
    )
    assert.equal((await readdir(base)).includes('escaped.txt'), false)
  })
})

test('a destination that is a directory is refused', async () => {
  await withTree(async ({ root, out }) => {
    await mkdir(join(out, targetName))
    const result = await run(root, out)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /not a regular file/)
  })
})

test('allowed: a fresh destination inside --out is written', async () => {
  await withTree(async ({ root, out }) => {
    const result = await run(root, out)
    assert.equal(result.code, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.summary.rendered, 1)
    assert.equal((await readFile(join(out, targetName), 'utf8')).startsWith(renderedBanner()), true)
  })
})

test('allowed: re-rendering over this tool\'s own output is not refused', async () => {
  await withTree(async ({ root, out }) => {
    await run(root, out)
    const first = await readFile(join(out, targetName), 'utf8')
    const result = await run(root, out)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(await readFile(join(out, targetName), 'utf8'), first)
  })
})

test('allowed: an output directory reached through a linked ancestor still works', async () => {
  // The false refusal is a defect too, and this is the shape that produces it:
  // on macOS every temporary directory sits under a symbolic link, so a guard
  // that refuses a linked ancestor refuses the ordinary case.
  await withTree(async ({ base, root, out }) => {
    const linkedBase = join(base, 'linked-base')
    await symlink(base, linkedBase)
    const result = await run(root, join(linkedBase, 'out'))
    assert.equal(result.code, 0, result.stderr)
    assert.equal((await readdir(out)).includes(targetName), true)
  })
})

test('allowed: other files in the output directory are left alone', async () => {
  await withTree(async ({ root, out }) => {
    const bystander = join(out, 'a-file-nobody-asked-about.txt')
    await writeFile(bystander, KEPT)
    const result = await run(root, out)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(await readFile(bystander, 'utf8'), KEPT)
  })
})

test('the guard reports the same identity a stat does', async () => {
  // Pins the comparison itself rather than the message: a hard link shares the
  // device and inode of the file it links to, which is the only thing that
  // distinguishes it from an unrelated path.
  await withTree(async ({ root, out }) => {
    const policy = join(root, 'policy.json')
    const hard = join(out, 'hard-link.txt')
    await link(policy, hard)
    const [a, b] = [await stat(policy), await stat(hard)]
    assert.equal(a.dev === b.dev && a.ino === b.ino, true)
    await assert.rejects(
      () => assertWritableDestination(hard, { inputs: [policy], root: out }),
      /same file as an input/,
    )
    await assert.doesNotReject(() => assertWritableDestination(hard, { inputs: [], root: out }))
  })
})

test('the binary the guard protects is the one under test', async () => {
  // A tautology check: every case above runs the real CLI, so the path it
  // takes has to exist.
  assert.match(CLI, /bin\/prompt-injection-fixture\.mjs$/)
  const probe = await cliRun(['--root', 'examples/clean', '--json'])
  assert.equal(probe.code, 0, probe.stderr)
  assert.equal(JSON.parse(probe.stdout).summary.rendered, 0)
  assert.ok(scenariosOf([scenario()]).scenarios.length === 1 && policyOf().channels.length > 0)
})
