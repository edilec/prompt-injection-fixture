/**
 * The precedence policy: which channels may carry instructions, in what order,
 * and how content is labelled when it is rendered.
 *
 * This file is the thing actually under test. A prompt-assembly pipeline that
 * exports its trust configuration here gets a regression suite over it: the day
 * somebody promotes `retrieval` from `content` to `instruction`, the scenarios
 * in this package stop passing.
 *
 * Nothing here interprets text. Compiling a policy is pure validation.
 */

import { byCodeUnit, describeValue, hasForbiddenCharacter, isPlainObject } from './text.mjs'

export const POLICY_SCHEMA_VERSION = '1'

/** Only two authorities exist, and the difference between them is the whole product. */
export const AUTHORITIES = Object.freeze(['content', 'instruction'])

export const POLICY_KEYS = Object.freeze(['channels', 'directives', 'envelope', 'schemaVersion'])
export const CHANNEL_KEYS = Object.freeze(['authority', 'name'])
export const DIRECTIVE_KEYS = Object.freeze(['default', 'name', 'settableBy'])
export const ENVELOPE_KEYS = Object.freeze(['close', 'open'])

/**
 * Channel and directive names are narrower than the general identifier rule.
 * They are printed inside the rendered envelope, so a name carrying a quote, an
 * angle bracket or a brace could close the envelope it is labelling.
 */
const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

export const MAX_CHANNELS = 32
export const MAX_DIRECTIVES = 64
export const MAX_VALUE_LENGTH = 200
export const MAX_ENVELOPE_LENGTH = 200

/** The shortest literal run of an envelope template that counts as a breakout marker. */
export const MIN_BREAKOUT_LITERAL = 3

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key)).sort(byCodeUnit)
}

/** A directive value: a label, not free prose, and never a control character. */
export function isDirectiveValue(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH) return false
  return !hasForbiddenCharacter(value)
}

/**
 * The literal runs of the open template, with the placeholders removed.
 *
 * Content that contains one of these can forge the start of an envelope and so
 * label itself as a different channel; content that contains the close marker
 * can leave its envelope altogether. Runs shorter than `MIN_BREAKOUT_LITERAL`
 * are dropped, because a one-character run such as `>` appears in ordinary
 * prose and would make the check useless noise.
 */
export function breakoutLiterals(envelope) {
  const literals = envelope.open
    .split(/\{channel\}|\{id\}/)
    .filter((part) => part.length >= MIN_BREAKOUT_LITERAL)
  literals.push(envelope.close)
  return Object.freeze([...new Set(literals)].sort(byCodeUnit))
}

function compileChannels(sink, file, raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    sink.add({
      file,
      ruleId: 'policy-invalid',
      pointer: '/channels',
      message: `channels must be a non-empty array of channel objects, in order of precedence; the policy has ${describeValue(raw)}.`,
      suggestion: 'List every channel your prompt assembler can produce, highest precedence first.',
    })
    return null
  }
  if (raw.length > MAX_CHANNELS) {
    sink.add({
      file,
      ruleId: 'policy-invalid',
      pointer: '/channels',
      message: `channels holds ${raw.length} entries, above the ${MAX_CHANNELS} this tool compiles.`,
    })
    return null
  }

  const channels = new Map()
  let usable = true
  for (const [index, entry] of raw.entries()) {
    const pointer = `/channels/${index}`
    if (!isPlainObject(entry)) {
      sink.add({ file, ruleId: 'policy-channel-invalid', pointer, message: `A channel must be an object; entry ${index} is ${describeValue(entry)}.` })
      usable = false
      continue
    }
    const extra = unknownKeys(entry, CHANNEL_KEYS)
    if (extra.length > 0) {
      sink.add({
        file,
        ruleId: 'policy-channel-invalid',
        pointer,
        message: `A channel accepts only ${CHANNEL_KEYS.join(' and ')}; entry ${index} also declares ${extra.join(', ')}.`,
        suggestion: 'Remove the unknown key. A key this tool ignores is a setting nobody is enforcing.',
      })
      usable = false
      continue
    }
    if (typeof entry.name !== 'string' || !NAME.test(entry.name)) {
      sink.add({
        file,
        ruleId: 'policy-channel-invalid',
        pointer: `${pointer}/name`,
        message: `A channel name must match ${NAME.source}; entry ${index} has ${describeValue(entry.name)}.`,
      })
      usable = false
      continue
    }
    if (!AUTHORITIES.includes(entry.authority)) {
      sink.add({
        file,
        ruleId: 'policy-channel-invalid',
        pointer: `${pointer}/authority`,
        message: `Channel "${entry.name}" must declare authority as one of ${AUTHORITIES.join(', ')}.`,
        suggestion: 'A channel whose text arrives from a document, a tool result or a quoted message is "content".',
      })
      usable = false
      continue
    }
    if (channels.has(entry.name)) {
      sink.add({
        file,
        ruleId: 'policy-channel-invalid',
        pointer: `${pointer}/name`,
        message: `Channel "${entry.name}" is declared more than once, so its precedence is ambiguous.`,
      })
      usable = false
      continue
    }
    channels.set(entry.name, Object.freeze({ name: entry.name, authority: entry.authority, rank: index }))
  }

  if (!usable) return null
  const instruction = [...channels.values()].filter((channel) => channel.authority === 'instruction')
  if (instruction.length === 0) {
    sink.add({
      file,
      ruleId: 'policy-invalid',
      pointer: '/channels',
      message: 'No channel has instruction authority, so no directive could ever be set and the policy asserts nothing.',
    })
    return null
  }
  const content = [...channels.values()].filter((channel) => channel.authority === 'content')
  if (content.length === 0) {
    sink.add({
      file,
      ruleId: 'policy-invalid',
      pointer: '/channels',
      message: 'No channel has content authority, so the trust boundary this tool exists to exercise is not in the policy.',
      suggestion: 'Declare the channels that carry tool results, retrieved documents and quoted messages as "content".',
    })
    return null
  }
  return channels
}

function compileDirectives(sink, file, raw, channels) {
  if (!Array.isArray(raw) || raw.length === 0) {
    sink.add({
      file,
      ruleId: 'policy-invalid',
      pointer: '/directives',
      message: `directives must be a non-empty array; the policy has ${describeValue(raw)}.`,
      suggestion: 'Declare the settings a scenario asserts about, such as the label a report is written under.',
    })
    return null
  }
  if (raw.length > MAX_DIRECTIVES) {
    sink.add({
      file,
      ruleId: 'policy-invalid',
      pointer: '/directives',
      message: `directives holds ${raw.length} entries, above the ${MAX_DIRECTIVES} this tool compiles.`,
    })
    return null
  }

  const directives = new Map()
  let usable = true
  for (const [index, entry] of raw.entries()) {
    const pointer = `/directives/${index}`
    if (!isPlainObject(entry)) {
      sink.add({ file, ruleId: 'policy-directive-invalid', pointer, message: `A directive must be an object; entry ${index} is ${describeValue(entry)}.` })
      usable = false
      continue
    }
    const extra = unknownKeys(entry, DIRECTIVE_KEYS)
    if (extra.length > 0) {
      sink.add({
        file,
        ruleId: 'policy-directive-invalid',
        pointer,
        message: `A directive accepts only ${DIRECTIVE_KEYS.join(', ')}; entry ${index} also declares ${extra.join(', ')}.`,
      })
      usable = false
      continue
    }
    if (typeof entry.name !== 'string' || !NAME.test(entry.name)) {
      sink.add({
        file,
        ruleId: 'policy-directive-invalid',
        pointer: `${pointer}/name`,
        message: `A directive name must match ${NAME.source}; entry ${index} has ${describeValue(entry.name)}.`,
      })
      usable = false
      continue
    }
    if (directives.has(entry.name)) {
      sink.add({ file, ruleId: 'policy-directive-invalid', pointer: `${pointer}/name`, message: `Directive "${entry.name}" is declared more than once.` })
      usable = false
      continue
    }
    if (!isDirectiveValue(entry.default)) {
      sink.add({
        file,
        ruleId: 'policy-directive-invalid',
        pointer: `${pointer}/default`,
        message: `Directive "${entry.name}" must declare a default of 1-${MAX_VALUE_LENGTH} characters with no control, separator or bidi character; it has ${describeValue(entry.default)}.`,
      })
      usable = false
      continue
    }
    const floor = channels.get(entry.settableBy)
    if (floor === undefined) {
      sink.add({
        file,
        ruleId: 'policy-directive-invalid',
        pointer: `${pointer}/settableBy`,
        message: `Directive "${entry.name}" names settableBy ${describeValue(entry.settableBy)}, which is not a declared channel.`,
      })
      usable = false
      continue
    }
    if (floor.authority !== 'instruction') {
      sink.add({
        file,
        ruleId: 'policy-directive-invalid',
        pointer: `${pointer}/settableBy`,
        message: `Directive "${entry.name}" names settableBy "${floor.name}", a content channel. Content never sets a directive, so the floor would be a contradiction.`,
        suggestion: 'Name the lowest-precedence instruction channel that is allowed to set this directive.',
      })
      usable = false
      continue
    }
    directives.set(entry.name, Object.freeze({
      name: entry.name,
      default: entry.default,
      settableBy: floor.name,
      floorRank: floor.rank,
    }))
  }

  return usable ? directives : null
}

function compileEnvelope(sink, file, raw) {
  if (!isPlainObject(raw)) {
    sink.add({
      file,
      ruleId: 'policy-invalid',
      pointer: '/envelope',
      message: `envelope must be an object with open and close templates; the policy has ${describeValue(raw)}.`,
    })
    return null
  }
  const extra = unknownKeys(raw, ENVELOPE_KEYS)
  if (extra.length > 0) {
    sink.add({
      file,
      ruleId: 'policy-invalid',
      pointer: '/envelope',
      message: `envelope accepts only ${ENVELOPE_KEYS.join(' and ')}; it also declares ${extra.join(', ')}.`,
    })
    return null
  }
  let usable = true
  for (const key of ENVELOPE_KEYS) {
    const value = raw[key]
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ENVELOPE_LENGTH) {
      sink.add({
        file,
        ruleId: 'policy-invalid',
        pointer: `/envelope/${key}`,
        message: `envelope.${key} must be a string of 1-${MAX_ENVELOPE_LENGTH} characters; it is ${describeValue(value)}.`,
      })
      usable = false
      continue
    }
    if (hasForbiddenCharacter(value)) {
      sink.add({
        file,
        ruleId: 'policy-invalid',
        pointer: `/envelope/${key}`,
        message: `envelope.${key} carries a control, separator or bidi character, which would forge or hide lines in the rendered fixture.`,
      })
      usable = false
    }
  }
  if (!usable) return null

  /**
   * The label is the guarantee. An open template that does not name the channel
   * renders content the reader cannot tell apart from an instruction, which is
   * the defect this whole package exists to catch -- so it is refused here
   * rather than rendered and reported as fine.
   */
  const missing = ['{channel}', '{id}'].filter((token) => !raw.open.includes(token))
  if (missing.length > 0) {
    sink.add({
      file,
      ruleId: 'envelope-unlabeled',
      pointer: '/envelope/open',
      message: `envelope.open must interpolate ${missing.join(' and ')} so that rendered content names the channel and segment it came from.`,
      suggestion: 'Use something like <untrusted-content channel="{channel}" segment="{id}">.',
    })
    return null
  }
  if (raw.close.includes('{channel}') || raw.close.includes('{id}')) {
    sink.add({
      file,
      ruleId: 'policy-invalid',
      pointer: '/envelope/close',
      message: 'envelope.close must be a fixed marker with no placeholders, so that a reader can find the end of untrusted content without parsing it.',
    })
    return null
  }

  const envelope = Object.freeze({ open: raw.open, close: raw.close })
  return Object.freeze({ ...envelope, literals: breakoutLiterals(envelope) })
}

/**
 * Compile a policy document, or return null after saying why not.
 *
 * Returning null is never a pass: the caller marks the run incomplete, because
 * a policy that did not compile means no scenario was evaluated against it.
 */
export function compilePolicy(sink, file, document) {
  if (!isPlainObject(document)) {
    sink.add({ file, ruleId: 'policy-invalid', pointer: '', message: `The policy must be a JSON object; it is ${describeValue(document)}.` })
    return null
  }
  const extra = unknownKeys(document, POLICY_KEYS)
  if (extra.length > 0) {
    sink.add({
      file,
      ruleId: 'policy-invalid',
      pointer: '',
      message: `The policy accepts only ${POLICY_KEYS.join(', ')}; it also declares ${extra.join(', ')}.`,
      suggestion: 'Remove the unknown key rather than leaving a setting this tool silently ignores.',
    })
    return null
  }
  if (document.schemaVersion !== POLICY_SCHEMA_VERSION) {
    sink.add({
      file,
      ruleId: 'policy-invalid',
      pointer: '/schemaVersion',
      message: `The policy must declare schemaVersion "${POLICY_SCHEMA_VERSION}"; it declares ${describeValue(document.schemaVersion)}.`,
    })
    return null
  }

  const channels = compileChannels(sink, file, document.channels)
  if (channels === null) return null
  const directives = compileDirectives(sink, file, document.directives, channels)
  if (directives === null) return null
  const envelope = compileEnvelope(sink, file, document.envelope)
  if (envelope === null) return null

  return Object.freeze({ channels, directives, envelope })
}
