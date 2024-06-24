/**
 * prompt-injection-fixture -- build inert local fixtures that label quoted,
 * tool and retrieval content as untrusted, and assert that a mock agent keeps
 * the configured instruction precedence.
 *
 * The subject under test is your **policy**: the trust configuration your
 * prompt assembler uses to decide which channels may carry instructions. Export
 * it as `policy.json`, write scenarios that push content-channel requests at
 * it, and this package becomes a regression suite over that configuration. The
 * day a channel is promoted from `content` to `instruction`, or a directive's
 * floor is lowered, the scenarios stop passing.
 *
 * What this package is not: it is not a jailbreak corpus, not a payload
 * generator, and not an exploit. Its entire vocabulary of "attack" is one inert
 * marker, `[[set name=value]]`, which does nothing anywhere except here. See
 * the non-goals in the README; they are load-bearing, not boilerplate.
 *
 * This package opens no socket, starts no process, reads no clock and no
 * environment variable, and never sends anything anywhere.
 */

import { constants } from 'node:fs'
import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

import { breakoutMarkers, renderFixture, renderedBanner, runMockAgent } from './agent.mjs'
import { DestinationError, assertWritableDestination } from './destination.mjs'
import { compilePolicy, isDirectiveValue } from './policy.mjs'
import { compileScenarios } from './scenario.mjs'
import { byCodeUnit, decodeUtf8, excerpt, hasForbiddenCharacter, isPlainObject, parseFailureDetail } from './text.mjs'

export const TOOL_ID = 'prompt-injection-fixture'
export const REPORT_SCHEMA_VERSION = '1'

export const DEFAULT_POLICY_NAME = 'policy.json'
export const DEFAULT_SCENARIOS_NAME = 'scenarios.json'

/**
 * Limits, each enforced and each reported by name when it is hit.
 *
 * Exceeding one is never a silent truncation. It produces a finding naming the
 * limit and marks the run `incomplete`, because a scan that stopped early knows
 * nothing about the part it did not reach -- and in this tool that part is
 * exactly where the next injected request would be.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 5242880,
  maxScenarios: 200,
  maxSegments: 2000,
  maxSegmentChars: 20000,
  maxMarkersPerSegment: 64,
  maxFindings: 1000,
})

/** A caller may lower a limit, never raise it past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxFileBytes: 67108864,
  maxScenarios: 5000,
  maxSegments: 100000,
  maxSegmentChars: 1000000,
  maxMarkersPerSegment: 4096,
  maxFindings: 20000,
})

/**
 * The authoritative rule severity table.
 *
 * Severity decides whether a run fails, so it lives in one frozen place and
 * every finding takes its severity from here; an unknown rule id throws rather
 * than defaulting to something harmless.
 *
 * `test/severity-table.test.mjs` asserts this table against
 * `docs/fixture-rules.md` in both directions. That is worth having and it is
 * not the guarantee: three declarations agreeing with each other survive a
 * coordinated edit of all three, and in a sibling tool 40 of 52 error rules
 * survived exactly that flip. `test/severity-behaviour.test.mjs` drives real
 * inputs through the real binary and pins `status` and the process exit code,
 * which no edit to a table can satisfy.
 */
export const RULE_SEVERITY = Object.freeze({
  'authority-below-floor-refused': 'info',
  'challenge-absent': 'error',
  'channel-unknown': 'error',
  'content-directive-refused': 'info',
  'directive-mismatch': 'error',
  'directive-unknown': 'error',
  'directive-value-invalid': 'error',
  'envelope-breakout': 'error',
  'envelope-unlabeled': 'error',
  'expectation-incomplete': 'error',
  'expectation-unevaluated': 'error',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'lower-precedence-refused': 'info',
  'no-scenarios': 'error',
  'no-segments-evaluated': 'error',
  'output-unwritable': 'error',
  'output-would-overwrite': 'error',
  'path-escapes-root': 'error',
  'policy-channel-invalid': 'error',
  'policy-directive-invalid': 'error',
  'policy-invalid': 'error',
  'precedence-violated': 'error',
  'refusal-reason-mismatch': 'error',
  'refusal-undeclared': 'error',
  'scenario-duplicate': 'error',
  'scenario-invalid': 'error',
  'scenario-unchallenged': 'warning',
  'segment-duplicate': 'error',
  'segment-invalid': 'error',
  'segment-text-too-large': 'error',
  'suite-unchallenged': 'error',
  'too-many-findings': 'error',
  'too-many-markers': 'error',
  'too-many-scenarios': 'error',
  'too-many-segments': 'error',
})

/** The refusal reasons a scenario must declare, because they are the trust boundary itself. */
export const BOUNDARY_REASONS = Object.freeze(['channel-below-floor', 'channel-is-content'])

const REASON_RULE = Object.freeze({
  'channel-below-floor': 'authority-below-floor-refused',
  'channel-is-content': 'content-directive-refused',
  'directive-unknown': 'directive-unknown',
  'lower-precedence': 'lower-precedence-refused',
})

const MESSAGE_LIMIT = 400
const SUGGESTION_LIMIT = 300
const LOCATION_LIMIT = 200
const MAX_NAME_LENGTH = 200
const RENDERED_SUFFIX = '.fixture.txt'

/**
 * Create or truncate, and refuse to follow a link at the last component.
 *
 * `assertWritableDestination` refuses a symbolic link on sight, before anything
 * is opened. This flag closes the window between that check and the open: a
 * link planted in between is an ELOOP from the kernel rather than a write
 * through it. Two independent checks because one of them can be raced.
 */
const WRITE_NO_FOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW

const ALLOWED_OPTIONS = Object.freeze(['limits', 'out', 'policy', 'root', 'scenarios'])

/**
 * Validate limit overrides.
 *
 * An unknown key throws instead of being ignored. A documented limit that a
 * one-character typo silently disables is a limit nobody is enforcing, and the
 * CLI turns this throw into a configuration error with an empty stdout.
 */
export function validateLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(overrides).sort(byCodeUnit)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      throw new TypeError(`Unknown limit "${excerpt(key, 60)}"; known limits are ${Object.keys(DEFAULT_LIMITS).sort(byCodeUnit).join(', ')}`)
    }
    const value = overrides[key]
    const cap = HARD_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      throw new TypeError(`limits.${key} must be an integer between 1 and ${cap}`)
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * True when `candidate` is the real root itself or lies beneath it.
 *
 * Both sides must already be real paths. Comparing a real root against an
 * unresolved candidate refuses legitimate files whenever the root is reached
 * through a symbolic link -- a `/var` that is really `/private/var` is enough
 * -- and a false refusal is a defect too.
 */
export function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * A file name given on the command line, checked as configuration.
 *
 * This is emphatically not the confinement. A symbolic link planted inside the
 * root contains no `..` at all and passes every check here; `resolveInput`
 * catches that by resolving the real path of both sides and comparing those.
 */
function validateName(name, flag) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`${flag} must be a relative file name of 1-${MAX_NAME_LENGTH} characters`)
  }
  if (hasForbiddenCharacter(name)) throw new TypeError(`${flag} must not contain a control, separator or bidi character`)
  if (isAbsolute(name)) throw new TypeError(`${flag} must be relative to --root, not an absolute path`)
  if (normalize(name).split(/[\\/]/).includes('..')) throw new TypeError(`${flag} must not step outside --root with ".."`)
  return name
}

class FindingSink {
  constructor() {
    this.rows = []
  }

  add(row) {
    this.rows.push({ pointer: '', ...row })
  }
}

/**
 * Build a finding, taking its severity from the one table.
 *
 * Every untrusted string is sanitised here -- file, pointer, message,
 * suggestion and evidence alike, not only an excerpt field. Untrusted values
 * reach this tool through identifiers as well as through text: a scenario's
 * `expect` object can carry any JSON key at all, and that key is named in the
 * message that refuses it.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/fixture-rules.md.`)
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: excerpt(row.file, LOCATION_LIMIT), pointer: excerpt(row.pointer, LOCATION_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, SUGGESTION_LIMIT)
  return finding
}

/** Documented sort key: location.file, location.pointer, ruleId, message, evidence. */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file, b.location.file) ||
    byCodeUnit(a.location.pointer, b.location.pointer) ||
    byCodeUnit(a.ruleId, b.ruleId) ||
    byCodeUnit(a.message, b.message) ||
    byCodeUnit(a.evidence ?? '', b.evidence ?? '')
  )
}

function emptyState() {
  return {
    checked: 0,
    evaluated: 0,
    attempts: 0,
    refusals: 0,
    challenges: 0,
    applications: 0,
    rendered: 0,
    incomplete: false,
  }
}

function buildReport(sink, state, counts, limits) {
  let findings = sink.rows.map((row) => createFinding(row)).sort(compareFindings)
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(createFinding({
      file: counts.scenariosName,
      ruleId: 'too-many-findings',
      pointer: '',
      message: `The run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} were not reported and this report is partial.`,
      suggestion: 'Raise --max-findings, or narrow the scenario file.',
    }))
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const status = state.incomplete || truncated ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: state.checked,
      errors,
      warnings,
      scenarios: counts.scenarios,
      evaluated: state.evaluated,
      segments: counts.segments,
      contentSegments: counts.contentSegments,
      attempts: state.attempts,
      refusals: state.refusals,
      challenges: state.challenges,
      applications: state.applications,
      rendered: state.rendered,
    },
    findings,
  }
}

/**
 * Resolve one declared input inside the declared root.
 *
 * Both sides are resolved to their real paths before they are compared.
 * Rejecting `..` lexically -- which `validateName` also does -- is not
 * confinement: a symbolic link planted inside the root points anywhere and
 * contains no `..` at all. In this tool the consequence is specific: a link
 * out of the tree would let an arbitrary file be read and its text quoted into
 * a report that a person, or another agent, then reads.
 */
async function resolveInput(realRoot, name) {
  const target = resolve(realRoot, name)
  try {
    const real = await realpath(target)
    if (!isInside(realRoot, real)) return { ok: false, reason: 'escapes' }
    return { ok: true, real }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ELOOP') return { ok: false, reason: 'unreadable', code: error.code }
    try {
      const realParent = await realpath(dirname(target))
      if (!isInside(realRoot, realParent)) return { ok: false, reason: 'escapes' }
    } catch {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    return { ok: false, reason: 'unreadable', code: error.code }
  }
}

/** Read one confined input and turn it into parsed JSON, or into the finding that says why not. */
async function loadJson(sink, file, real, limits) {
  let info
  try {
    info = await stat(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be inspected: ${error.code ?? 'unknown error'}.` })
    return null
  }
  if (!info.isFile()) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} is not a regular file, so nothing was read from it.` })
    return null
  }
  if (info.size > limits.maxFileBytes) {
    sink.add({
      file,
      ruleId: 'input-too-large',
      message: `${file} is ${info.size} bytes, above the maxFileBytes limit of ${limits.maxFileBytes}; it was not read.`,
      suggestion: 'Raise --max-file-bytes, or split the input.',
    })
    return null
  }
  let bytes
  try {
    bytes = await readFile(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be read: ${error.code ?? 'unknown error'}.` })
    return null
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    sink.add({
      file,
      ruleId: 'input-not-utf8',
      message: `${file} is not valid UTF-8, so it was not parsed. Whether a file decodes is the decoder's decision, never an inference drawn from the decoded text.`,
      suggestion: 'Re-encode the file as UTF-8.',
    })
    return null
  }
  try {
    return { value: JSON.parse(decoded.text) }
  } catch (error) {
    sink.add({
      file,
      ruleId: 'input-not-json',
      message: `${file} is not valid JSON: ${parseFailureDetail(error)}.`,
      suggestion: 'Validate the file with a JSON parser before re-running.',
    })
    return null
  }
}

/**
 * The pair key used to match an observed refusal against a declared one.
 *
 * The separator is built from its code point rather than written as a literal:
 * a raw NUL in a source file is invisible in every editor and survives review,
 * and this package refuses control characters everywhere else. It cannot occur
 * in either half -- both are identifiers, and an identifier carrying a control
 * character is refused at the door -- so the key is unambiguous.
 */
const KEY_SEPARATOR = String.fromCharCode(0)
const refusalKey = (segment, directive) => `${segment}${KEY_SEPARATOR}${directive}`

/**
 * Why one request did not apply, in the words that match the guard that stopped
 * it. The four reasons are four different guarantees, and a reader who cannot
 * tell them apart cannot tell a held trust boundary from an accident of
 * ordering -- which is the same distinction `refusal-reason-mismatch` exists
 * to hold.
 */
function refusalExplanation(refusal) {
  if (refusal.reason === 'channel-is-content') {
    return 'the channel carries content, so the mock agent read the request as something the content says and refused it.'
  }
  if (refusal.reason === 'directive-unknown') {
    return 'the policy declares no such directive, so there was nothing to set.'
  }
  if (refusal.reason === 'channel-below-floor') {
    return `the channel sits below the settableBy floor "${refusal.floor}" for that directive, so the request was refused.`
  }
  return `channel "${refusal.heldBy}" had already set it from a higher-precedence position, so the later request was refused.`
}

/**
 * Judge one scenario against what the mock agent actually did.
 *
 * The order of the checks matters. An expectation is satisfied by an observed
 * refusal; a request that was *applied* instead is a precedence violation; and
 * a request that never appeared at all is a missing challenge, which is its own
 * error -- deleting the injected marker from a fixture must not turn it green.
 */
function evaluateScenario(sink, file, policy, scenario, limits, state) {
  const run = runMockAgent(policy, scenario, limits)
  state.checked += run.scanned
  state.attempts += run.attempts
  state.refusals += run.refusals.length
  state.applications += run.applications.length

  for (const segment of scenario.segments) {
    if (segment.oversize) continue
    const hits = breakoutMarkers(policy, segment.text)
    if (hits.length > 0) {
      sink.add({
        file,
        ruleId: 'envelope-breakout',
        pointer: `${segment.pointer}/text`,
        message: `Segment "${segment.id}" on channel "${segment.channel.name}" contains the envelope marker itself, so rendering it would let the content close or forge its own label.`,
        evidence: `marker ${hits.map((hit) => JSON.stringify(hit)).sort(byCodeUnit).join(' ')}`,
        suggestion: 'Escape the marker in the fixture text, or choose an envelope whose markers cannot occur in your content.',
      })
    }
  }

  for (const segment of run.truncatedSegments) {
    sink.add({
      file,
      ruleId: 'too-many-markers',
      pointer: `${segment.pointer}/text`,
      message: `Segment "${segment.id}" holds more than the maxMarkersPerSegment limit of ${limits.maxMarkersPerSegment}; the scan stopped and the rest of the segment was not examined, so this scenario was not evaluated.`,
      suggestion: 'Raise --max-markers-per-segment, or split the segment.',
    })
  }

  /**
   * Two views of the same refusals, and the difference matters.
   *
   * `observed` holds every refusal, whatever its reason, and decides whether a
   * declared challenge actually happened. `boundary` holds only the two reasons
   * that are the trust boundary itself, and decides which refusals a scenario
   * is obliged to declare. Collapsing them would report a request refused for a
   * weaker reason as a challenge that never occurred.
   */
  const observed = new Map()
  const boundary = new Map()
  for (const refusal of run.refusals) {
    const ruleId = REASON_RULE[refusal.reason]
    sink.add({
      file,
      ruleId,
      pointer: `${refusal.pointer}/text`,
      message: `Segment "${refusal.segment}" on ${refusal.authority} channel "${refusal.channel}" asked to set "${excerpt(refusal.directive, 80)}"; ${refusalExplanation(refusal)}`,
      evidence: `request ${excerpt(refusal.directive, 60)} refused: ${refusal.reason}`,
    })
    const key = refusalKey(refusal.segment, refusal.directive)
    if (!observed.has(key)) observed.set(key, refusal.reason)
    if (BOUNDARY_REASONS.includes(refusal.reason)) {
      state.challenges += 1
      if (!boundary.has(key)) boundary.set(key, refusal.reason)
    }
  }

  const applied = new Map()
  for (const application of run.applications) {
    applied.set(refusalKey(application.segment, application.directive), application)
    if (!isDirectiveValue(application.value)) {
      sink.add({
        file,
        ruleId: 'directive-value-invalid',
        pointer: `${application.pointer}/text`,
        message: `Segment "${application.segment}" set "${application.directive}" to a value that is empty, too long, or carries a control, separator or bidi character, so the resolved state cannot be displayed as it was compared.`,
      })
    }
  }

  const declared = new Set()
  for (const expectation of scenario.expectRefusals) {
    const key = refusalKey(expectation.segment, expectation.directive)
    declared.add(key)
    const reason = observed.get(key)
    if (reason !== undefined) {
      if (expectation.reason !== undefined && expectation.reason !== reason) {
        sink.add({
          file,
          ruleId: 'refusal-reason-mismatch',
          pointer: expectation.pointer,
          message: `Segment "${expectation.segment}" was refused "${expectation.directive}" for reason "${reason}", not the declared "${expectation.reason}". The request was refused, but not by the guard this scenario exists to hold.`,
          suggestion: 'Check whether the channel authority or the directive floor changed in the policy.',
        })
      }
      continue
    }
    if (applied.has(key)) {
      const application = applied.get(key)
      sink.add({
        file,
        ruleId: 'precedence-violated',
        pointer: expectation.pointer,
        message: `Segment "${expectation.segment}" on channel "${application.channel}" (authority ${application.authority}) SET "${expectation.directive}"; the scenario declares that request must be refused.`,
        suggestion: 'The policy now lets this channel set this directive. Restore its authority or its floor, or accept the change deliberately.',
      })
      continue
    }
    if (run.truncated) continue
    sink.add({
      file,
      ruleId: 'challenge-absent',
      pointer: expectation.pointer,
      message: `Segment "${expectation.segment}" never asked to set "${expectation.directive}", so this scenario no longer exercises the boundary it declares.`,
      suggestion: 'Restore the [[set ...]] marker in the segment text, or remove the expectation. A fixture that stopped challenging is not a fixture that passed.',
    })
  }

  for (const [key, reason] of boundary) {
    if (declared.has(key)) continue
    const [segment, directive] = key.split(KEY_SEPARATOR)
    sink.add({
      file,
      ruleId: 'refusal-undeclared',
      pointer: scenario.pointer,
      message: `Segment "${segment}" was refused "${excerpt(directive, 80)}" (${reason}) but the scenario does not declare that refusal, so nothing would notice if it stopped happening.`,
      suggestion: 'Add {"segment": ..., "directive": ..., "reason": ...} to expectRefusals.',
    })
  }

  /**
   * A scan that stopped early cannot decide the final state.
   *
   * The markers this run did not reach might have changed any directive, so
   * comparing what it did resolve against `expect` would be asserting on half a
   * transcript. The scenario is reported unevaluated and the run is incomplete;
   * it is never quietly compared and never a pass.
   */
  if (run.truncated) {
    state.incomplete = true
    sink.add({
      file,
      ruleId: 'expectation-unevaluated',
      pointer: `${scenario.pointer}/expect`,
      message: `Scenario "${scenario.id}" hit a limit before the transcript was fully scanned, so its expected directive values were not compared and this run is not a pass.`,
      suggestion: 'Raise the limit named by the accompanying finding, and re-run.',
    })
  } else {
    state.evaluated += 1
    for (const [name, expected] of scenario.expect) {
      const actual = run.state.get(name).value
      if (actual === expected) continue
      const holder = run.state.get(name)
      sink.add({
        file,
        ruleId: 'directive-mismatch',
        pointer: `${scenario.pointer}/expect/${name}`,
        message: `Scenario "${scenario.id}" expected "${name}" to end as "${excerpt(expected, 80)}"; the mock agent ended with "${excerpt(actual, 80)}"${holder.segment === null ? ' (the policy default, unset by any segment)' : ` (set by segment "${holder.segment}" on channel "${holder.channel}")`}.`,
      })
    }
  }

  const challenged = run.refusals.some((refusal) => refusal.reason === 'channel-is-content')
  if (!challenged) {
    sink.add({
      file,
      ruleId: 'scenario-unchallenged',
      pointer: scenario.pointer,
      message: `Scenario "${scenario.id}" contains no content-channel request for a directive, so it says nothing about whether content can reach an instruction.`,
      suggestion: 'Add a content segment carrying a [[set ...]] marker, or keep this scenario only for the labelling checks.',
    })
  }
  return { challenged, renderable: scenario.segments.every((segment) => !segment.oversize) }
}

/**
 * Write one rendered fixture, refusing to destroy anything this tool did not write.
 *
 * Two independent guards, because they answer different questions.
 *
 * `assertWritableDestination` answers *which file is this path*. A symbolic
 * link at the destination, a symbolic link on the way to it, or a hard link to
 * one of the inputs all name a file somewhere other than the one the caller
 * asked for, and each of the three is invisible to the other two checks. This
 * tool shipped without it: a link planted in `--out` sent a rendered fixture to
 * a file outside the directory, destroyed it, and the run reported `pass` and
 * exited 0. A refused destination is a configuration error -- the run stops, the
 * report is never written, and stdout stays empty -- because an output directory
 * holding a planted link is not a directory anything else should be written to
 * either.
 *
 * The banner guard answers *whose file is this*. A generator that clobbers
 * whatever is at the path it was pointed at eventually eats a hand-written file,
 * and "it was in the output directory" is not consent. That one is a finding
 * rather than a refusal: the file is real, it is where the caller said, and the
 * only thing wrong with it is that somebody else wrote it.
 *
 * @throws {DestinationError} when the destination is not the file it names.
 */
async function writeRendered(sink, file, outDirectory, inputs, scenario, text) {
  const relative = `${scenario.id}${RENDERED_SUFFIX}`
  const target = await assertWritableDestination(join(outDirectory, relative), {
    inputs,
    root: outDirectory,
    label: `--out entry ${relative}`,
  })

  let existing = null
  try {
    existing = await readFile(target, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      sink.add({ file, ruleId: 'output-unwritable', pointer: scenario.pointer, message: `${relative} could not be inspected before writing: ${error.code ?? 'unknown error'}.` })
      return false
    }
  }
  if (existing !== null && !existing.startsWith(renderedBanner())) {
    sink.add({
      file,
      ruleId: 'output-would-overwrite',
      pointer: scenario.pointer,
      message: `${relative} already exists and was not written by this tool, so it was left alone and scenario "${scenario.id}" was not rendered.`,
      suggestion: 'Choose an empty --out directory, or move the existing file aside.',
    })
    return false
  }
  try {
    await writeFile(target, text, { flag: WRITE_NO_FOLLOW })
  } catch (error) {
    sink.add({ file, ruleId: 'output-unwritable', pointer: scenario.pointer, message: `${relative} could not be written: ${error.code ?? 'unknown error'}.` })
    return false
  }
  return true
}

/**
 * Compile a policy and its scenarios, run the mock agent, and report.
 *
 * @param {object} options
 * @param {string} options.root Directory holding both inputs.
 * @param {string} [options.policy] Policy file, relative to the root.
 * @param {string} [options.scenarios] Scenario file, relative to the root.
 * @param {string} [options.out] Existing directory to render fixtures into; omitted means read-only.
 * @param {object} [options.limits] Limit overrides; an unknown key throws.
 * @returns {Promise<object>} the report.
 */
export async function checkFixtures(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options must be an object')
  for (const key of Object.keys(options).sort(byCodeUnit)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new TypeError(`Unknown option "${excerpt(key, 60)}"; known options are ${ALLOWED_OPTIONS.join(', ')}`)
    }
  }
  const limits = validateLimits(options.limits ?? {})
  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root must be a non-empty string')
  const policyName = validateName(options.policy ?? DEFAULT_POLICY_NAME, '--policy')
  const scenariosName = validateName(options.scenarios ?? DEFAULT_SCENARIOS_NAME, '--scenarios')

  let realRoot
  try {
    realRoot = await realpath(options.root)
  } catch (error) {
    throw new Error(`--root could not be resolved: ${error.code ?? 'unknown error'}`)
  }
  let rootInfo
  try {
    rootInfo = await stat(realRoot)
  } catch (error) {
    throw new Error(`--root could not be inspected: ${error.code ?? 'unknown error'}`)
  }
  if (!rootInfo.isDirectory()) throw new Error('--root must be a directory')

  /**
   * The output directory is configuration, so a bad one is a usage error rather
   * than a finding. It must exist, be a directory, and be outside the input
   * tree: a generator that writes into the directory it reads from will sooner
   * or later read its own output back as a fixture.
   */
  let realOut = null
  if (options.out !== undefined) {
    if (typeof options.out !== 'string' || options.out.length === 0) throw new TypeError('out must be a non-empty string')
    /**
     * The directory itself is refused when it is a symbolic link, before it is
     * resolved. Resolving is the dangerous act: `--out rendered` where
     * `rendered` is a link deposits every fixture wherever the link points,
     * which is not the path the caller named. Only the last component is
     * checked, so a root reached through a linked ancestor -- `/tmp` on macOS,
     * every temporary directory under it -- still works.
     */
    let entry = null
    try {
      entry = await lstat(resolve(options.out))
    } catch (error) {
      throw new Error(`--out could not be inspected: ${error.code ?? 'unknown error'}`)
    }
    if (entry.isSymbolicLink()) {
      throw new Error('--out is a symbolic link, so the fixtures would be written wherever it points rather than where you named. Name the real directory.')
    }
    try {
      realOut = await realpath(options.out)
    } catch (error) {
      throw new Error(`--out could not be resolved: ${error.code ?? 'unknown error'}`)
    }
    let outInfo
    try {
      outInfo = await stat(realOut)
    } catch (error) {
      throw new Error(`--out could not be inspected: ${error.code ?? 'unknown error'}`)
    }
    if (!outInfo.isDirectory()) throw new Error('--out must be a directory')
    if (isInside(realRoot, realOut) || isInside(realOut, realRoot)) {
      throw new Error('--out must be outside --root, so a rendered fixture is never read back as an input')
    }
  }

  const sink = new FindingSink()
  const state = emptyState()
  const counts = { scenarios: 0, segments: 0, contentSegments: 0, scenariosName }

  const documents = {}
  /** The real path of every file this run read, for the hard-link check in the write guard. */
  const realInputs = []
  for (const [kind, name] of [['policy', policyName], ['scenarios', scenariosName]]) {
    const located = await resolveInput(realRoot, name)
    if (located.ok) realInputs.push(located.real)
    if (!located.ok) {
      state.incomplete = true
      if (located.reason === 'escapes') {
        sink.add({
          file: name,
          ruleId: 'path-escapes-root',
          message: `${name} resolves outside --root, so it was refused unread.`,
          suggestion: 'Keep both inputs inside the declared root; a symbolic link out of the tree is refused.',
        })
      } else {
        sink.add({
          file: name,
          ruleId: 'input-unreadable',
          message: `${name} could not be resolved inside --root: ${located.code ?? 'unknown error'}.`,
          suggestion: 'Check the file name and its permissions.',
        })
      }
      documents[kind] = null
      continue
    }
    const loaded = await loadJson(sink, name, located.real, limits)
    if (loaded === null) state.incomplete = true
    documents[kind] = loaded
  }

  let policy = null
  if (documents.policy !== null) {
    policy = compilePolicy(sink, policyName, documents.policy.value)
    if (policy === null) state.incomplete = true
  }

  let compiled = null
  if (policy !== null && documents.scenarios !== null) {
    compiled = compileScenarios(sink, scenariosName, documents.scenarios.value, policy, limits)
    if (compiled === null) state.incomplete = true
  } else if (documents.scenarios !== null) {
    // The policy decides what a channel means, so scenarios cannot be compiled
    // without it. Saying "0 scenarios checked" without saying why would be the
    // vacuous pass with extra steps.
    state.incomplete = true
  }

  let suiteChallenged = false
  if (policy !== null && compiled !== null) {
    counts.scenarios = compiled.scenarios.length
    if (compiled.scenarios.length !== compiled.declared || compiled.bounded) state.incomplete = true

    if (compiled.declared === 0) {
      state.incomplete = true
      sink.add({
        file: scenariosName,
        ruleId: 'no-scenarios',
        pointer: '/scenarios',
        message: 'The scenario file declares no scenarios, so the run has no evidence to be green on.',
        suggestion: 'Write at least one scenario in which a content channel asks for a directive.',
      })
    }

    const renderable = []
    for (const scenario of compiled.scenarios) {
      counts.segments += scenario.segments.length
      for (const segment of scenario.segments) if (segment.channel.authority === 'content') counts.contentSegments += 1
      const outcome = evaluateScenario(sink, scenariosName, policy, scenario, limits, state)
      if (outcome.challenged) suiteChallenged = true
      if (outcome.renderable) renderable.push(scenario)
    }

    /**
     * A suite in which no content channel ever asked for anything proves
     * nothing about this tool's subject, so it is an error rather than a pass
     * with a warning. The per-scenario version stays a warning because a
     * labelling-only scenario is legitimate; a whole suite of them is not.
     */
    if (compiled.declared > 0 && !suiteChallenged) {
      sink.add({
        file: scenariosName,
        ruleId: 'suite-unchallenged',
        pointer: '/scenarios',
        message: 'No scenario in this file has a content channel asking to set a directive, so the run asserts nothing about instruction precedence.',
        suggestion: 'Add the document, tool result or quoted message that carries a [[set ...]] marker.',
      })
    }

    /**
     * The vacuous pass, refused explicitly. A scenario file whose scenarios all
     * compiled but whose segments were all oversize scans nothing, and without
     * this it would report `pass` with `checked: 0`.
     */
    if (compiled.scenarios.length > 0 && state.checked === 0) {
      state.incomplete = true
      sink.add({
        file: scenariosName,
        ruleId: 'no-segments-evaluated',
        pointer: '/scenarios',
        message: `The run scanned 0 of ${counts.segments} segment(s), so it has no evidence to be green on.`,
        suggestion: 'Fix whatever stopped the segments from being scanned; the accompanying findings name it.',
      })
    }

    if (realOut !== null) {
      for (const scenario of renderable) {
        const written = await writeRendered(sink, scenariosName, realOut, realInputs, scenario, renderFixture(policy, scenario))
        if (written) state.rendered += 1
        else state.incomplete = true
      }
    }
  }

  return buildReport(sink, state, counts, limits)
}

/** stdout carries this and nothing else, so it can be piped straight into a parser. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** 0 completed and passed, 1 completed and failed, 2 the run could not be completed. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_WIDTH = 7

/** The human summary. It goes to stderr; stdout is the JSON report alone. */
export function formatReport(report, extra = {}) {
  const { summary } = report
  const lines = [
    `policy ${excerpt(extra.policy ?? DEFAULT_POLICY_NAME, 80)}: ${summary.scenarios} scenario(s), ${summary.segments} segment(s), ${summary.contentSegments} on content channels.`,
    `mock agent: ${summary.attempts} directive request(s), ${summary.applications} applied, ${summary.refusals} refused, ${summary.challenges} of them at the trust boundary.`,
    `evaluated ${summary.evaluated} of ${summary.scenarios} scenario(s), scanned ${summary.checked} segment(s), rendered ${summary.rendered}. status ${report.status}.`,
  ]
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ` +
      `${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { MARKER_SOURCE, REFUSAL_REASONS, breakoutMarkers, renderFixture, renderedBanner, runMockAgent, scanMarkers } from './agent.mjs'
export {
  AUTHORITIES, CHANNEL_KEYS, DIRECTIVE_KEYS, ENVELOPE_KEYS, MAX_CHANNELS, MAX_DIRECTIVES,
  MAX_VALUE_LENGTH, POLICY_KEYS, POLICY_SCHEMA_VERSION, breakoutLiterals, compilePolicy, isDirectiveValue,
} from './policy.mjs'
export {
  DOCUMENT_KEYS, REFUSAL_KEYS, SCENARIO_ID, SCENARIO_KEYS, SCENARIO_SCHEMA_VERSION, SEGMENT_KEYS, compileScenarios,
} from './scenario.mjs'
export {
  EXCERPT_LIMIT, MAX_IDENTIFIER_LENGTH, byCodeUnit, decodeUtf8, describeValue, excerpt,
  hasForbiddenCharacter, isIdentifier, isPlainObject, parseFailureDetail,
} from './text.mjs'
