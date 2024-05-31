/**
 * The mock agent, and the renderer that produces the inert fixture.
 *
 * The mock agent is deliberately small and deliberately not a model. It reads
 * one inert marker -- `[[set name=value]]` -- and decides, using only the
 * compiled policy, whether the segment carrying that marker was allowed to set
 * that directive. Everything it refuses, it records.
 *
 * That marker is the whole of this package's "attack" vocabulary, and the
 * choice is the point. A fixture's job is to say "a document asked for a
 * different report label, and here is the assertion that the request was
 * treated as content". It does not need -- and this package does not ship --
 * natural-language jailbreak phrasings, an exfiltration channel, or anything
 * that would do something if it were pointed at a real model. Substitute your
 * own product's prose around the marker if you want the fixture to read like
 * the documents you actually retrieve; the marker is what the mock agent acts
 * on, and it acts on it by refusing.
 */

/**
 * The inert directive marker.
 *
 * The value stops at a closing bracket or a line break, so a marker is always
 * one line and always self-delimiting. Built fresh per scan because a global
 * regular expression carries `lastIndex` between calls, and a shared one would
 * make the second scan of the same text return different results from the
 * first -- a determinism bug that only shows up once there are two segments.
 */
export const MARKER_SOURCE = '\\[\\[set ([A-Za-z][A-Za-z0-9_.-]{0,63})=([^\\]\\r\\n]{0,200})\\]\\]'

export const REFUSAL_REASONS = Object.freeze([
  'channel-below-floor',
  'channel-is-content',
  'directive-unknown',
  'lower-precedence',
])

/**
 * Find every directive marker in a segment.
 *
 * `limit` bounds the scan. Hitting it returns `truncated: true`, and the caller
 * must not then report that the segment contained no further request: a scan
 * that stopped early knows nothing about the rest of the text, and reporting
 * that silence as absence is precisely how an unknown becomes a pass.
 */
export function scanMarkers(text, limit) {
  const pattern = new RegExp(MARKER_SOURCE, 'g')
  const markers = []
  let match = pattern.exec(text)
  while (match !== null) {
    if (markers.length >= limit) return { markers, truncated: true }
    markers.push({ name: match[1], value: match[2], index: match.index })
    match = pattern.exec(text)
  }
  return { markers, truncated: false }
}

/**
 * Run the mock agent over one compiled scenario.
 *
 * Precedence has two independent parts, and a policy can get either wrong:
 *
 * - **Authority.** A channel declared `content` never sets a directive, full
 *   stop. This is the trust boundary, and it does not depend on where the
 *   channel sits in the order.
 * - **Order and floor.** Among instruction channels, an assignment applies only
 *   if the channel is at or above the directive's `settableBy` floor, and only
 *   if no higher-precedence channel has already set that directive. Two
 *   assignments from the same channel resolve in document order, later last.
 *
 * Every attempt that does not apply is recorded as a refusal with the reason it
 * did not, so a scenario can assert the refusal happened rather than inferring
 * it from the final value. Inferring it would pass just as happily when the
 * marker was deleted from the fixture.
 */
export function runMockAgent(policy, scenario, limits) {
  const state = new Map()
  for (const directive of policy.directives.values()) {
    state.set(directive.name, { value: directive.default, rank: Number.POSITIVE_INFINITY, segment: null, channel: null })
  }

  const applications = []
  const refusals = []
  const truncatedSegments = []
  let truncated = false
  let scanned = 0
  let attempts = 0

  for (const segment of scenario.segments) {
    if (segment.oversize) {
      // Reported at compile time as segment-text-too-large. It is recorded here
      // only so the caller knows this scenario's final state is not decidable.
      truncated = true
      continue
    }
    scanned += 1
    const scan = scanMarkers(segment.text, limits.maxMarkersPerSegment)
    if (scan.truncated) {
      truncated = true
      truncatedSegments.push({ id: segment.id, pointer: segment.pointer })
    }

    for (const marker of scan.markers) {
      attempts += 1
      const record = {
        segment: segment.id,
        pointer: segment.pointer,
        channel: segment.channel.name,
        authority: segment.channel.authority,
        directive: marker.name,
        value: marker.value,
      }

      // Authority first. A content channel is refused whatever it names, so an
      // undeclared directive arriving from a retrieved document is reported as
      // the boundary event it is, not as a fixture typo.
      if (segment.channel.authority === 'content') {
        refusals.push({ ...record, reason: 'channel-is-content' })
        continue
      }
      const directive = policy.directives.get(marker.name)
      if (directive === undefined) {
        refusals.push({ ...record, reason: 'directive-unknown' })
        continue
      }
      if (segment.channel.rank > directive.floorRank) {
        refusals.push({ ...record, reason: 'channel-below-floor', floor: directive.settableBy })
        continue
      }
      const current = state.get(directive.name)
      if (segment.channel.rank > current.rank) {
        refusals.push({ ...record, reason: 'lower-precedence', heldBy: current.channel })
        continue
      }
      applications.push(record)
      state.set(directive.name, {
        value: marker.value,
        rank: segment.channel.rank,
        segment: segment.id,
        channel: segment.channel.name,
      })
    }
  }

  return { state, applications, refusals, truncated, truncatedSegments, scanned, attempts }
}

/** True when a segment's text carries a marker that would let it escape or forge an envelope. */
export function breakoutMarkers(policy, text) {
  return policy.envelope.literals.filter((literal) => text.includes(literal))
}

const BANNER = '# prompt-injection-fixture rendered fixture -- generated from a scenario file, do not edit'

/** The first line every rendered fixture carries, so the writer can tell its own output from yours. */
export function renderedBanner() {
  return BANNER
}

/**
 * Render one scenario as an inert transcript.
 *
 * Instruction segments get a plain header. Content segments are wrapped in the
 * policy's envelope, which names the channel and the segment id -- that label
 * is the guarantee the rest of this package checks, so the renderer refuses to
 * produce a fixture from a policy whose open template does not interpolate
 * both, and `compilePolicy` never returns such a policy.
 *
 * The output is a function of the policy and the scenario alone: no clock, no
 * environment, no path. Two runs over the same inputs produce the same bytes.
 */
export function renderFixture(policy, scenario) {
  const lines = [
    BANNER,
    `# scenario: ${scenario.id}`,
  ]
  if (scenario.title !== undefined) lines.push(`# title: ${scenario.title}`)
  lines.push(`# channels: ${[...policy.channels.values()].map((channel) => `${channel.name}=${channel.authority}`).join(' ')}`)
  lines.push('')

  for (const segment of scenario.segments) {
    if (segment.source !== undefined) lines.push(`# source: ${segment.source}`)
    if (segment.channel.authority === 'content') {
      lines.push(policy.envelope.open.replaceAll('{channel}', segment.channel.name).replaceAll('{id}', segment.id))
      lines.push(segment.text)
      lines.push(policy.envelope.close)
    } else {
      lines.push(`[${segment.channel.name}] (${segment.channel.authority}, segment ${segment.id})`)
      lines.push(segment.text)
    }
    lines.push('')
  }

  return `${lines.join('\n')}`
}
