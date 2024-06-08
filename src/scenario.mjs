/**
 * Scenarios: ordered transcripts of channel-labelled segments, each with the
 * outcome the fixture author expects the mock agent to reach.
 *
 * A segment's `text` is data. This module validates its shape and its size and
 * never interprets it; the only text this tool ever reads for meaning is the
 * inert `[[set name=value]]` marker, and that reading happens in `agent.mjs`
 * against the compiled policy.
 */

import { byCodeUnit, describeValue, hasForbiddenCharacter, isIdentifier, isPlainObject } from './text.mjs'
import { MAX_VALUE_LENGTH, isDirectiveValue } from './policy.mjs'
import { REFUSAL_REASONS } from './agent.mjs'

export const SCENARIO_SCHEMA_VERSION = '1'

export const DOCUMENT_KEYS = Object.freeze(['scenarios', 'schemaVersion'])
export const SCENARIO_KEYS = Object.freeze(['expect', 'expectRefusals', 'id', 'segments', 'title'])
export const SEGMENT_KEYS = Object.freeze(['channel', 'id', 'source', 'text'])
export const REFUSAL_KEYS = Object.freeze(['directive', 'reason', 'segment'])

/**
 * A scenario id also names a rendered file, so it is narrower than a general
 * identifier: no separator, no leading dot, nothing that could place a written
 * fixture somewhere other than the directory the caller named.
 */
export const SCENARIO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/**
 * Separates the two halves of a duplicate-detection key. Built from its code
 * point: a literal control character in a source file is invisible, and both
 * halves are identifiers, which may not contain one.
 */
const PAIR_SEPARATOR = String.fromCharCode(1)

const MAX_TITLE_LENGTH = 200
const MAX_SOURCE_LENGTH = 200

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key)).sort(byCodeUnit)
}

function compileSegments(sink, file, scenarioPointer, raw, policy, budget) {
  if (!Array.isArray(raw) || raw.length === 0) {
    sink.add({
      file,
      ruleId: 'scenario-invalid',
      pointer: `${scenarioPointer}/segments`,
      message: `segments must be a non-empty array in the order the prompt assembler would emit them; this scenario has ${describeValue(raw)}.`,
    })
    return null
  }

  const segments = []
  const seen = new Set()
  let usable = true
  for (const [index, entry] of raw.entries()) {
    const pointer = `${scenarioPointer}/segments/${index}`
    if (budget.remaining <= 0) return { segments, stopped: pointer }
    budget.remaining -= 1

    if (!isPlainObject(entry)) {
      sink.add({ file, ruleId: 'segment-invalid', pointer, message: `A segment must be an object; entry ${index} is ${describeValue(entry)}.` })
      usable = false
      continue
    }
    const extra = unknownKeys(entry, SEGMENT_KEYS)
    if (extra.length > 0) {
      sink.add({
        file,
        ruleId: 'segment-invalid',
        pointer,
        message: `A segment accepts only ${SEGMENT_KEYS.join(', ')}; entry ${index} also declares ${extra.join(', ')}.`,
      })
      usable = false
      continue
    }
    if (!isIdentifier(entry.id)) {
      sink.add({ file, ruleId: 'segment-invalid', pointer: `${pointer}/id`, message: `A segment id must be a printable identifier; entry ${index} has ${describeValue(entry.id)}.` })
      usable = false
      continue
    }
    if (seen.has(entry.id)) {
      sink.add({
        file,
        ruleId: 'segment-duplicate',
        pointer: `${pointer}/id`,
        message: `Segment "${entry.id}" appears more than once in this scenario, so an expectation naming it would be ambiguous.`,
      })
      usable = false
      continue
    }
    const channel = policy.channels.get(entry.channel)
    if (channel === undefined) {
      sink.add({
        file,
        ruleId: 'channel-unknown',
        pointer: `${pointer}/channel`,
        message: `Segment "${entry.id}" names channel ${describeValue(entry.channel)}, which the policy does not declare, so its authority is unknown.`,
        suggestion: 'Add the channel to the policy, or correct the segment. An undeclared channel is never assumed to be content.',
      })
      usable = false
      continue
    }
    if (typeof entry.text !== 'string') {
      sink.add({ file, ruleId: 'segment-invalid', pointer: `${pointer}/text`, message: `Segment "${entry.id}" must carry text as a string; it has ${describeValue(entry.text)}.` })
      usable = false
      continue
    }
    if (entry.source !== undefined && (typeof entry.source !== 'string' || entry.source.length === 0 || entry.source.length > MAX_SOURCE_LENGTH || hasForbiddenCharacter(entry.source))) {
      sink.add({
        file,
        ruleId: 'segment-invalid',
        pointer: `${pointer}/source`,
        message: `Segment "${entry.id}" declares a source that is not a printable string of 1-${MAX_SOURCE_LENGTH} characters.`,
      })
      usable = false
      continue
    }

    const oversize = entry.text.length > budget.maxSegmentChars
    if (oversize) {
      sink.add({
        file,
        ruleId: 'segment-text-too-large',
        pointer: `${pointer}/text`,
        message: `Segment "${entry.id}" holds ${entry.text.length} characters, above the maxSegmentChars limit of ${budget.maxSegmentChars}; it was not scanned for directives and this scenario was not evaluated.`,
        suggestion: 'Raise --max-segment-chars, or shorten the segment. A segment nobody scanned is not a segment nobody had to worry about.',
      })
    }

    seen.add(entry.id)
    segments.push(Object.freeze({
      id: entry.id,
      channel,
      text: entry.text,
      source: entry.source,
      pointer,
      oversize,
    }))
  }

  if (!usable) return null
  return { segments, stopped: null }
}

function compileExpect(sink, file, scenarioPointer, raw, policy) {
  if (!isPlainObject(raw)) {
    sink.add({
      file,
      ruleId: 'scenario-invalid',
      pointer: `${scenarioPointer}/expect`,
      message: `expect must be an object mapping every declared directive to the value the mock agent should end with; this scenario has ${describeValue(raw)}.`,
    })
    return null
  }
  let usable = true
  const expect = new Map()
  for (const key of Object.keys(raw).sort(byCodeUnit)) {
    if (!policy.directives.has(key)) {
      sink.add({
        file,
        ruleId: 'scenario-invalid',
        pointer: `${scenarioPointer}/expect/${key}`,
        message: `expect names "${key}", which the policy does not declare as a directive.`,
      })
      usable = false
      continue
    }
    if (!isDirectiveValue(raw[key])) {
      sink.add({
        file,
        ruleId: 'scenario-invalid',
        pointer: `${scenarioPointer}/expect/${key}`,
        message: `expect."${key}" must be a string of 1-${MAX_VALUE_LENGTH} characters with no control, separator or bidi character.`,
      })
      usable = false
      continue
    }
    expect.set(key, raw[key])
  }
  if (!usable) return null

  /**
   * Every declared directive must be named.
   *
   * An omitted directive is an unknown: nobody said what it should end as, so
   * nothing can be asserted about it, and a fixture that silently asserts
   * nothing about half the policy is the vacuous pass wearing a scenario id.
   */
  const missing = [...policy.directives.keys()].filter((name) => !expect.has(name)).sort(byCodeUnit)
  if (missing.length > 0) {
    sink.add({
      file,
      ruleId: 'expectation-incomplete',
      pointer: `${scenarioPointer}/expect`,
      message: `expect does not name ${missing.join(', ')}, so this scenario asserts nothing about ${missing.length} declared directive(s).`,
      suggestion: 'Name every directive the policy declares, even the ones this scenario does not try to change.',
    })
    return null
  }
  return expect
}

function compileRefusals(sink, file, scenarioPointer, raw, segments) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    sink.add({
      file,
      ruleId: 'scenario-invalid',
      pointer: `${scenarioPointer}/expectRefusals`,
      message: `expectRefusals must be an array of {segment, directive} pairs; this scenario has ${describeValue(raw)}.`,
    })
    return null
  }
  const known = new Set(segments.map((segment) => segment.id))
  const seen = new Set()
  const refusals = []
  let usable = true
  for (const [index, entry] of raw.entries()) {
    const pointer = `${scenarioPointer}/expectRefusals/${index}`
    if (!isPlainObject(entry) || unknownKeys(entry, REFUSAL_KEYS).length > 0) {
      sink.add({ file, ruleId: 'scenario-invalid', pointer, message: `An expectRefusals entry must be an object with exactly ${REFUSAL_KEYS.join(' and ')}.` })
      usable = false
      continue
    }
    if (!isIdentifier(entry.segment) || !known.has(entry.segment)) {
      sink.add({
        file,
        ruleId: 'scenario-invalid',
        pointer: `${pointer}/segment`,
        message: `expectRefusals entry ${index} names a segment that is not in this scenario.`,
      })
      usable = false
      continue
    }
    if (!isIdentifier(entry.directive)) {
      sink.add({ file, ruleId: 'scenario-invalid', pointer: `${pointer}/directive`, message: `expectRefusals entry ${index} must name a directive as a printable identifier.` })
      usable = false
      continue
    }
    if (entry.reason !== undefined && !REFUSAL_REASONS.includes(entry.reason)) {
      sink.add({
        file,
        ruleId: 'scenario-invalid',
        pointer: `${pointer}/reason`,
        message: `expectRefusals entry ${index} declares a reason that is not one of ${REFUSAL_REASONS.join(', ')}.`,
        suggestion: 'Declare the reason you mean to hold. An expectation with no reason is satisfied by any refusal, including one for a weaker guard.',
      })
      usable = false
      continue
    }
    const key = `${entry.segment}${PAIR_SEPARATOR}${entry.directive}`
    if (seen.has(key)) {
      sink.add({ file, ruleId: 'scenario-invalid', pointer, message: `expectRefusals entry ${index} repeats a pair already declared in this scenario.` })
      usable = false
      continue
    }
    seen.add(key)
    refusals.push(Object.freeze({ segment: entry.segment, directive: entry.directive, reason: entry.reason, pointer }))
  }
  return usable ? refusals : null
}

/**
 * Compile the scenario document against an already-compiled policy.
 *
 * @returns {{declared: number, scenarios: object[], bounded: boolean}|null}
 *   `declared` is how many scenarios the file claimed; a shorter `scenarios`
 *   array means some did not compile, and the caller treats that as incomplete.
 */
export function compileScenarios(sink, file, document, policy, limits) {
  if (!isPlainObject(document)) {
    sink.add({ file, ruleId: 'scenario-invalid', pointer: '', message: `The scenario file must be a JSON object; it is ${describeValue(document)}.` })
    return null
  }
  const extra = unknownKeys(document, DOCUMENT_KEYS)
  if (extra.length > 0) {
    sink.add({ file, ruleId: 'scenario-invalid', pointer: '', message: `The scenario file accepts only ${DOCUMENT_KEYS.join(', ')}; it also declares ${extra.join(', ')}.` })
    return null
  }
  if (document.schemaVersion !== SCENARIO_SCHEMA_VERSION) {
    sink.add({
      file,
      ruleId: 'scenario-invalid',
      pointer: '/schemaVersion',
      message: `The scenario file must declare schemaVersion "${SCENARIO_SCHEMA_VERSION}"; it declares ${describeValue(document.schemaVersion)}.`,
    })
    return null
  }
  if (!Array.isArray(document.scenarios)) {
    sink.add({ file, ruleId: 'scenario-invalid', pointer: '/scenarios', message: `scenarios must be an array; it is ${describeValue(document.scenarios)}.` })
    return null
  }

  const declared = document.scenarios.length
  let bounded = false
  const budget = { remaining: limits.maxSegments, maxSegmentChars: limits.maxSegmentChars }
  const scenarios = []
  const seen = new Set()

  for (const [index, entry] of document.scenarios.entries()) {
    const pointer = `/scenarios/${index}`
    if (scenarios.length >= limits.maxScenarios) {
      sink.add({
        file,
        ruleId: 'too-many-scenarios',
        pointer,
        message: `The file declares ${declared} scenarios, above the maxScenarios limit of ${limits.maxScenarios}; the walk stopped here and the rest were not compiled.`,
        suggestion: 'Raise --max-scenarios, or split the file.',
      })
      bounded = true
      break
    }
    if (!isPlainObject(entry)) {
      sink.add({ file, ruleId: 'scenario-invalid', pointer, message: `A scenario must be an object; entry ${index} is ${describeValue(entry)}.` })
      continue
    }
    const extraKeys = unknownKeys(entry, SCENARIO_KEYS)
    if (extraKeys.length > 0) {
      sink.add({ file, ruleId: 'scenario-invalid', pointer, message: `A scenario accepts only ${SCENARIO_KEYS.join(', ')}; entry ${index} also declares ${extraKeys.join(', ')}.` })
      continue
    }
    if (typeof entry.id !== 'string' || !SCENARIO_ID.test(entry.id)) {
      sink.add({
        file,
        ruleId: 'scenario-invalid',
        pointer: `${pointer}/id`,
        message: `A scenario id must match ${SCENARIO_ID.source}; entry ${index} has ${describeValue(entry.id)}.`,
        suggestion: 'The id also names the rendered fixture file, so it carries no separator and no leading dot.',
      })
      continue
    }
    if (seen.has(entry.id)) {
      sink.add({
        file,
        ruleId: 'scenario-duplicate',
        pointer: `${pointer}/id`,
        message: `Scenario "${entry.id}" appears more than once; a rendered fixture would overwrite the earlier one.`,
      })
      continue
    }
    if (entry.title !== undefined && (typeof entry.title !== 'string' || entry.title.length === 0 || entry.title.length > MAX_TITLE_LENGTH || hasForbiddenCharacter(entry.title))) {
      sink.add({ file, ruleId: 'scenario-invalid', pointer: `${pointer}/title`, message: `Scenario "${entry.id}" declares a title that is not a printable string of 1-${MAX_TITLE_LENGTH} characters.` })
      continue
    }

    const compiled = compileSegments(sink, file, pointer, entry.segments, policy, budget)
    if (compiled === null) continue
    if (compiled.stopped !== null) {
      sink.add({
        file,
        ruleId: 'too-many-segments',
        pointer: compiled.stopped,
        message: `The file holds more segments than the maxSegments limit of ${limits.maxSegments}; the walk stopped here and neither this scenario nor any later one was evaluated.`,
        suggestion: 'Raise --max-segments, or split the file.',
      })
      bounded = true
      break
    }
    const expect = compileExpect(sink, file, pointer, entry.expect, policy)
    if (expect === null) continue
    const expectRefusals = compileRefusals(sink, file, pointer, entry.expectRefusals, compiled.segments)
    if (expectRefusals === null) continue

    seen.add(entry.id)
    scenarios.push(Object.freeze({
      id: entry.id,
      title: entry.title,
      pointer,
      segments: Object.freeze(compiled.segments),
      expect,
      expectRefusals: Object.freeze(expectRefusals),
    }))
  }

  return { declared, scenarios, bounded }
}
