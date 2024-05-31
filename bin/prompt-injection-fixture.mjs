#!/usr/bin/env node

import process from 'node:process'

import {
  DEFAULT_POLICY_NAME,
  DEFAULT_SCENARIOS_NAME,
  checkFixtures,
  excerpt,
  exitCodeFor,
  formatReport,
  serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `prompt-injection-fixture

Build inert local fixtures that label quoted, tool and retrieval content as
untrusted, and assert that a mock agent keeps the configured instruction
precedence. Nothing is sent anywhere: the mock agent is a few dozen lines of
local code, and the only request it ever reads is the inert marker
[[set name=value]].

Usage:
  prompt-injection-fixture --root DIR [--policy FILE] [--scenarios FILE]
                           [--out DIR] [--json]
                           [--max-file-bytes N] [--max-scenarios N]
                           [--max-segments N] [--max-segment-chars N]
                           [--max-markers-per-segment N] [--max-findings N]

Options:
  --root DIR                  Directory holding both inputs (required)
  --policy FILE               Precedence policy, relative to --root
                              (default ${DEFAULT_POLICY_NAME})
  --scenarios FILE            Scenario file, relative to --root
                              (default ${DEFAULT_SCENARIOS_NAME})
  --out DIR                   Existing directory to render fixtures into. Must
                              be outside --root. Omit it and the run reads only.
  --json                      Suppress the human summary on stderr
  --max-file-bytes N          Maximum bytes per input file (default 5242880)
  --max-scenarios N           Maximum scenarios compiled (default 200)
  --max-segments N            Maximum segments across the file (default 2000)
  --max-segment-chars N       Maximum characters per segment (default 20000)
  --max-markers-per-segment N Maximum directive markers scanned per segment
                              (default 64)
  --max-findings N            Maximum findings in one report (default 1000)
  -h, --help                  Show this help
  -v, --version               Show the version

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins.

What a pass means:
  Every scenario reached the directive values it declared, every declared
  refusal actually happened for the reason it declared, and no content segment
  carried a marker that would let it escape its label. It is a statement about
  the policy in --policy and the transcripts in --scenarios, and about nothing
  else. A real model is not involved and no claim is made about one.

Exit codes:
  0  every scenario was evaluated and matched what it declared
  1  a scenario was evaluated and contradicted what it declared
  2  invalid configuration (no report on stdout), or evidence that could not be
     obtained (an "incomplete" report on stdout, never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-findings', 'maxFindings'],
  ['--max-markers-per-segment', 'maxMarkersPerSegment'],
  ['--max-scenarios', 'maxScenarios'],
  ['--max-segment-chars', 'maxSegmentChars'],
  ['--max-segments', 'maxSegments'],
])

const VALUE_FLAGS = new Map([
  ['--out', 'out'],
  ['--policy', 'policy'],
  ['--root', 'root'],
  ['--scenarios', 'scenarios'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { root: null, policy: null, scenarios: null, out: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once. Letting it repeat discards
   * the earlier value with no diagnostic, so `--scenarios a --scenarios b`
   * checks a file nobody named and `--max-segments 5 --max-segments 5000`
   * enforces a bound nobody asked for.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    // argv is the one untrusted string that reaches a stream without passing
    // through a finding, so it is flattened exactly as a finding would be.
    } else throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    report = await checkFixtures({
      root: options.root,
      limits: options.limits,
      ...(options.policy === null ? {} : { policy: options.policy }),
      ...(options.scenarios === null ? {} : { scenarios: options.scenarios }),
      ...(options.out === null ? {} : { out: options.out }),
    })
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty and a
    // consumer piping stdout gets nothing rather than a fabricated report.
    process.stderr.write(`${excerpt(error.message, 400)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) {
    process.stderr.write(formatReport(report, {
      policy: options.policy ?? DEFAULT_POLICY_NAME,
      scenarios: options.scenarios ?? DEFAULT_SCENARIOS_NAME,
    }))
  }
  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.evaluated} of ${report.summary.scenarios} scenario(s) were evaluated; this run is not a pass.\n`,
    )
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
