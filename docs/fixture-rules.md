# Rule catalog, configuration and limits

This document is the reference for `prompt-injection-fixture`. The severity
column is asserted against `RULE_SEVERITY` in `src/index.mjs` in both
directions by `test/severity-table.test.mjs`, and every rule is additionally
driven through the real binary by `test/severity-behaviour.test.mjs`, which
pins the status and the process exit code rather than the table.

## The inert marker

The mock agent reads exactly one thing out of segment text:

```
[[set <directiveName>=<value>]]
```

- `<directiveName>` matches `[A-Za-z][A-Za-z0-9_.-]{0,63}`.
- `<value>` is up to 200 characters and stops at a `]`, a carriage return or a
  newline, so a marker is always one line and always self-delimiting.
- The match is exact and case-sensitive. `[[SET x=y]]`, `[[set x = y]]` and
  `[set x=y]` are prose.

This is the whole of the package's "attack" vocabulary, and that is deliberate.
A fixture's job is to say *a document asked for a different report label, and
here is the assertion that the request was treated as content*. Put your own
product's prose around the marker if you want the fixture to read like the
documents you actually retrieve. See **Non-goals** in the README.

## Refusal reasons

Four reasons, in the order the mock agent checks them. A scenario may declare
the reason it means to hold; an expectation with no `reason` is satisfied by
any of them.

| Reason | Meaning |
| --- | --- |
| `channel-is-content` | The channel has `content` authority. This is the trust boundary, and it does not depend on ordering. |
| `directive-unknown` | An instruction channel named a directive the policy does not declare. |
| `channel-below-floor` | An instruction channel sits below the directive's `settableBy` floor. |
| `lower-precedence` | A higher-precedence channel had already set that directive. |

`channel-is-content` and `channel-below-floor` are the **boundary reasons**: a
scenario must declare every refusal that happens for one of them, so that a
refusal silently disappearing is a failure rather than a quieter report.

## Rule catalog

| ruleId | severity | fires when |
| --- | --- | --- |
| `authority-below-floor-refused` | info | An instruction channel below a directive's floor asked to set it, and was refused. |
| `challenge-absent` | error | A declared refusal never happened because the segment no longer asks for that directive at all. |
| `channel-unknown` | error | A segment names a channel the policy does not declare, so its authority is unknown. |
| `content-directive-refused` | info | A content channel asked to set a directive, and the request was treated as content. |
| `directive-mismatch` | error | A scenario's `expect` value differs from what the mock agent resolved. |
| `directive-unknown` | error | An instruction channel asked to set a directive the policy does not declare. |
| `directive-value-invalid` | error | An applied value is empty, over 200 characters, or carries a control, separator or bidi character. |
| `envelope-breakout` | error | Segment text contains the envelope's own markers, so rendering would let the content close or forge its label. |
| `envelope-unlabeled` | error | `envelope.open` does not interpolate both `{channel}` and `{id}`. |
| `expectation-incomplete` | error | A scenario's `expect` does not name every declared directive. |
| `expectation-unevaluated` | error | A limit stopped the scan, so the scenario's expected values were not compared. |
| `input-not-json` | error | An input file is not valid JSON. |
| `input-not-utf8` | error | An input file is not valid UTF-8, as decided by a strict decoder. |
| `input-too-large` | error | An input file is above `maxFileBytes` and was not read. |
| `input-unreadable` | error | An input could not be resolved, inspected or read. |
| `lower-precedence-refused` | info | A request was refused because a higher-precedence channel had already set that directive. |
| `no-scenarios` | error | The scenario file declares no scenarios. |
| `no-segments-evaluated` | error | Scenarios compiled but nothing was scanned. |
| `output-unwritable` | error | A rendered fixture could not be written. |
| `output-would-overwrite` | error | The target file exists and was not written by this tool, so it was left alone. |
| `path-escapes-root` | error | An input's real path lies outside the real `--root`. |
| `policy-channel-invalid` | error | A channel entry is malformed, duplicated, or has an authority outside `content` / `instruction`. |
| `policy-directive-invalid` | error | A directive entry is malformed, duplicated, or names a floor that is not an instruction channel. |
| `policy-invalid` | error | The policy document, its channel set or its envelope is malformed. |
| `precedence-violated` | error | A request the scenario declares must be refused was applied instead. |
| `refusal-reason-mismatch` | error | A declared refusal happened, but for a different reason than the one declared. |
| `refusal-undeclared` | error | A boundary refusal happened that the scenario does not declare. |
| `scenario-duplicate` | error | Two scenarios share an id. |
| `scenario-invalid` | error | A scenario's id, title, `expect` or `expectRefusals` is malformed. |
| `scenario-unchallenged` | warning | A scenario has no content-channel request for a directive. |
| `segment-duplicate` | error | Two segments in one scenario share an id. |
| `segment-invalid` | error | A segment is malformed or carries an unknown key. |
| `segment-text-too-large` | error | A segment is above `maxSegmentChars` and was not scanned. |
| `suite-unchallenged` | error | No scenario in the file has a content channel asking for a directive. |
| `too-many-findings` | error | The run produced more findings than `maxFindings`; the report is partial. |
| `too-many-markers` | error | A segment holds more markers than `maxMarkersPerSegment`; the scan stopped. |
| `too-many-scenarios` | error | The file declares more scenarios than `maxScenarios`; the walk stopped. |
| `too-many-segments` | error | The file holds more segments than `maxSegments`; the walk stopped. |

## Policy document

```json
{
  "schemaVersion": "1",
  "channels": [
    { "name": "system", "authority": "instruction" },
    { "name": "user", "authority": "instruction" },
    { "name": "retrieval", "authority": "content" }
  ],
  "directives": [
    { "name": "reportLabel", "default": "baseline", "settableBy": "system" }
  ],
  "envelope": {
    "open": "<untrusted-content channel=\"{channel}\" segment=\"{id}\">",
    "close": "</untrusted-content>"
  }
}
```

- `channels` is ordered: index 0 is the highest precedence. At least one
  `instruction` channel and at least one `content` channel are required.
- `settableBy` names the **lowest-precedence instruction channel** allowed to
  set that directive. Naming a content channel is refused as a contradiction.
- `envelope.open` must interpolate both `{channel}` and `{id}`; `envelope.close`
  must be a fixed marker with no placeholders.
- An unknown key anywhere in the document is refused, never ignored.

## Scenario document

```json
{
  "schemaVersion": "1",
  "scenarios": [
    {
      "id": "retrieved-document-requests-a-different-report-label",
      "title": "optional",
      "segments": [
        { "id": "system-turn", "channel": "system", "text": "[[set reportLabel=baseline]]" },
        { "id": "vendor-note", "channel": "retrieval", "source": "optional/path.md",
          "text": "[[set reportLabel=vendor-preferred]]" }
      ],
      "expect": { "reportLabel": "baseline" },
      "expectRefusals": [
        { "segment": "vendor-note", "directive": "reportLabel", "reason": "channel-is-content" }
      ]
    }
  ]
}
```

- `id` matches `[A-Za-z0-9][A-Za-z0-9._-]{0,99}`. It also names the rendered
  file, so it carries no separator and no leading dot.
- `expect` must name **every** declared directive. An omitted directive is an
  unknown, and a scenario that asserts nothing about half the policy is a
  vacuous pass with a scenario id on it.
- `expectRefusals` is optional. Omitting `reason` accepts any refusal; naming
  one asserts which guard held.
- `source` is metadata for the rendered header only. It is never opened: this
  tool reads the two files it was given and nothing else.

## Limits

| Limit | Flag | Default | Hard cap |
| --- | --- | ---: | ---: |
| `maxFileBytes` | `--max-file-bytes` | 5242880 | 67108864 |
| `maxScenarios` | `--max-scenarios` | 200 | 5000 |
| `maxSegments` | `--max-segments` | 2000 | 100000 |
| `maxSegmentChars` | `--max-segment-chars` | 20000 | 1000000 |
| `maxMarkersPerSegment` | `--max-markers-per-segment` | 64 | 4096 |
| `maxFindings` | `--max-findings` | 1000 | 20000 |

Exceeding a limit is never a silent truncation. It produces a finding naming
the limit, marks the run `incomplete`, and exits 2. In particular, a scan
stopped by `maxMarkersPerSegment` does **not** report the requests it did not
reach as absent, and does not compare the scenario's expected values at all:
the markers nobody read could have changed any of them.

An unknown limit key is a configuration error, not a value to ignore.

## Determinism

- Findings sort by `(location.file, location.pointer, ruleId, message, evidence)`.
- Every comparison is by UTF-16 code unit. Neither `localeCompare` nor
  `Intl.Collator` appears in this package, and `test/ordering.test.mjs` pins the
  emitted order with inputs an English collator orders the other way round --
  a source scan cannot tell one comparator from its replacement.
- No clock, no environment variable, no random source and no filesystem
  enumeration order affects output. Two runs over identical inputs produce
  byte-identical stdout, and a re-rendered fixture is byte-identical too.
