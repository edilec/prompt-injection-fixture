# Prompt Injection Fixture

Build inert local fixtures that label quoted, tool and retrieval content as
untrusted, and assert that a mock agent keeps the configured instruction
precedence.

- **Repository:** [edilec/prompt-injection-fixture](https://github.com/edilec/prompt-injection-fixture)
- **Area:** Prompt & Agent Workflows
- **License:** MIT

## What it does

An agent assembles a prompt from several sources: a system instruction, a
developer turn, the user's message, a tool result, a retrieved document, a
quoted forwarded email. Some of those may carry instructions. Most of them must
not. Which is which is a **policy**, and it usually lives as a few conditionals
scattered through a prompt assembler where nothing watches it.

This tool makes that policy an artifact and puts a regression suite around it.

1. You export the policy as `policy.json`: the channels in precedence order,
   each marked `instruction` or `content`, and the directives an instruction
   channel is allowed to set.
2. You write scenarios: ordered transcripts in which content channels ask for
   things, with the directive values you expect the agent to end with and the
   refusals you expect to see.
3. The tool runs a small deterministic **mock agent** over each transcript and
   reports where the outcome differs from what you declared.
4. With `--out`, it also renders each scenario as an inert text fixture in which
   every content segment is wrapped in an envelope naming the channel and the
   segment it came from.

The day somebody promotes `retrieval` from `content` to `instruction`, or lowers
a directive's floor, the suite goes red. That is the whole product.

## Why it exists

Because "we treat retrieved text as data" is a sentence, and sentences do not
fail a build. The failure mode this tool is built against is not a clever
prompt; it is a configuration drifting quietly until content can reach an
instruction, with every existing test still green.

The second failure mode it is built against is fixture rot. A fixture that
asserts "the label is still `baseline`" passes just as happily after somebody
deletes the injected request from the document — it is asserting that nothing
changed nothing. So a scenario declares the refusals it expects, and a request
that is no longer being made is an error (`challenge-absent`), not a pass.

## Quick start

```sh
# the clean example: every request refused, exits 0
node bin/prompt-injection-fixture.mjs --root examples/clean

# the same fixtures against a policy where retrieval was promoted: exits 1
node bin/prompt-injection-fixture.mjs --root examples/broken

# render the inert fixtures into a directory outside the input tree
mkdir -p /tmp/fixtures
node bin/prompt-injection-fixture.mjs --root examples/clean --out /tmp/fixtures
cat /tmp/fixtures/retrieved-document-requests-a-different-report-label.fixture.txt

# machine-readable report only
node bin/prompt-injection-fixture.mjs --root examples/clean --json | jq .status
```

As a library:

```js
import { checkFixtures, exitCodeFor } from 'prompt-injection-fixture'

const report = await checkFixtures({ root: 'fixtures/prompt-policy' })
process.exitCode = exitCodeFor(report)
```

## The inert marker

The mock agent reads exactly one thing out of segment text:

```
[[set reportLabel=vendor-preferred]]
```

That is the entire vocabulary. A retrieved document in a scenario looks like a
retrieved document — your own prose, your own formatting — with one marker in it
standing in for whatever the real content says. The marker does nothing
anywhere except here, which is the point: see **Non-goals**.

## Rules

Full catalog, with configuration and limits, in
[`docs/fixture-rules.md`](docs/fixture-rules.md). The rules that carry the
product:

| ruleId | severity | fires when |
| --- | --- | --- |
| `content-directive-refused` | info | A content channel asked to set a directive and the request was treated as content. |
| `precedence-violated` | error | A request the scenario declares must be refused was applied instead. |
| `refusal-reason-mismatch` | error | The request was refused, but by a different guard than the one declared. |
| `challenge-absent` | error | A declared request is no longer in the segment text, so the fixture stopped exercising the boundary. |
| `refusal-undeclared` | error | A boundary refusal happened that the scenario does not declare. |
| `directive-mismatch` | error | The mock agent resolved a directive to something other than `expect`. |
| `envelope-breakout` | error | Content carries the envelope's own markers, so rendering it would let the content forge or close its label. The scenario is not rendered. |
| `suite-unchallenged` | error | No content channel anywhere in the file asked for anything, so the run asserts nothing. |
| `expectation-unevaluated` | error | A limit stopped the scan, so the expected values were not compared. |

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | Every scenario was evaluated and matched what it declared. | the JSON report |
| `1` | A scenario was evaluated and contradicted what it declared. | the JSON report |
| `2` | Invalid configuration, or evidence that could not be obtained. | **empty** for a configuration error; an `incomplete` report for an input that could not be read |

A consumer piping stdout must handle the empty case. A configuration error never
had a subject, so there is nothing to report about; emitting a fake report for a
run that never started would be worse.

`incomplete` is never interchangeable with `pass`. Evidence this tool did not
obtain does not satisfy a check and is never reported as absence.

## Limits

| Limit | Flag | Default |
| --- | --- | ---: |
| `maxFileBytes` | `--max-file-bytes` | 5242880 |
| `maxScenarios` | `--max-scenarios` | 200 |
| `maxSegments` | `--max-segments` | 2000 |
| `maxSegmentChars` | `--max-segment-chars` | 20000 |
| `maxMarkersPerSegment` | `--max-markers-per-segment` | 64 |
| `maxFindings` | `--max-findings` | 1000 |

Exceeding one is an `incomplete` result with a finding naming the limit, never a
silent truncation. An unknown limit key is a configuration error.

## Guarantees

Each of these has a test that fails when the guarantee is removed.

- **Content never sets a directive**, whatever it names and whatever the order.
  Authority is checked before the directive is even looked up.
- **A refused request is not automatically a held boundary.** A scenario can
  declare which of the four guards must be the one that refused.
- **A fixture that stopped challenging fails.** Deleting the marker raises
  `challenge-absent`.
- **A bounded scan never reports what it did not read.** Hitting
  `maxMarkersPerSegment` or `maxSegmentChars` leaves the scenario unevaluated
  and the run `incomplete`, and reports nothing as absent.
- **Nothing untrusted reaches output raw.** Segment text is never echoed into
  the report at all, and every identifier, path, pointer, message and piece of
  evidence is stripped of C0, DEL, C1, U+2028/U+2029 and the bidi controls.
- **A JSON parse failure never reproduces the document.** V8 embeds raw input in
  its message; this package keeps the offset and drops the quoted half.
- **Path confinement is by real path**, not by rejecting `..`. A symbolic link
  planted inside the root is refused unread.
- **Output is deterministic and byte-identical** across runs, machines and Node
  builds. Ordering is by UTF-16 code unit.
- **Rendering destroys nothing.** Three independent checks, because no one of
  them catches the others: a symbolic link at the destination or at `--out`
  itself is refused before it is resolved, a destination whose *resolved* parent
  leaves `--out` is refused, and a hard link to one of the inputs is refused by
  device and inode -- it shares no path with the input and is the same file. A
  refused destination stops the run with exit 2 and no report. On top of that, a
  real file that does not start with this tool's generated banner is left alone
  and the run goes `incomplete`.
- **Two scenario ids that differ only in case are a collision**, on every
  filesystem, because the id names the rendered file and half the world's
  filesystems are case-insensitive.
- **Content that would escape its envelope is never written.** `envelope-breakout`
  refuses the render as well as failing the run; detecting an escape and then
  producing the file would hand a fixture runner exactly the unsafe artifact.

## Non-goals

These are boundaries on what this package is, not a to-do list.

- **It is not a jailbreak corpus.** It ships no natural-language attack
  phrasings, no prompt library, and no technique catalog. The one marker it
  reads is a fixture convention that does nothing outside this tool.
- **It is not a payload generator.** It emits only the fixture author's own
  text, wrapped in a label. There is no function that synthesises attack
  content, and the exported surface is frozen by a test so one cannot arrive
  quietly.
- **It is not an exfiltration harness.** It opens no socket, starts no process,
  reads no environment variable, and calls no model. The examples contain no
  URL, host or address.
- **It does not test a real model.** The mock agent is a few dozen lines of
  local code implementing your declared precedence. A pass says your *policy*
  and your *transcripts* agree; it says nothing about how any model behaves.
- **It does not detect injection in prose.** There is no heuristic that reads
  text and guesses whether it is an instruction. A heuristic like that would be
  a guess wearing a guard's uniform.
- **It does not fix anything.** It is read-only unless `--out` is given, and
  even then it writes only rendered fixtures into a directory outside the input
  tree -- and only to destinations that are the file they name. See
  [`docs/fixture-rules.md`](docs/fixture-rules.md#writing-rendered-fixtures).

## Verification

```sh
npm run check     # lint, tests, the runnable example, and a packaging dry run
```

Zero runtime dependencies and zero development dependencies. Node 22 or newer,
ESM, `node:test` and `node:assert/strict`.

## Production context

A passing fixture shows that this mock agent followed the declared precedence;
it does not prove that a live RAG system resists prompt injection. Edilec's
[RAG prompt-injection threat model](https://edilec.com/blog/cyb-11001/prompt-injection-threat-model-rag/)
maps the separate ingestion, retrieval, context, tool and recovery boundaries
that need their own controls and tests.

## License

MIT. See [LICENSE](./LICENSE).
