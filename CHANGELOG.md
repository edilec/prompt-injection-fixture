# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a precedence policy format: channels in precedence order, each declared
  `instruction` or `content`, and directives with a `settableBy` floor naming
  the lowest-precedence instruction channel allowed to set them;
- a deterministic mock agent that reads one inert marker, `[[set name=value]]`,
  and refuses a request for one of four named reasons -- the channel carries
  content, the policy declares no such directive, the channel is below the
  directive's floor, or a higher-precedence channel already set it;
- a scenario format that declares both the directive values the transcript
  should end with and the refusals that must happen, optionally naming which of
  the four guards must be the one that refused;
- `precedence-violated` and `refusal-reason-mismatch`, which together catch a
  channel promoted out of `content` whether or not ordering happens to mask it;
- `challenge-absent`, so that deleting an injected request from a fixture fails
  instead of passing -- a fixture asserting "nothing changed" passes forever
  once the thing that was meant to change it is gone;
- `suite-unchallenged`, refusing a whole file in which no content channel ever
  asks for anything;
- `envelope-breakout`, refusing content that carries the envelope's own markers
  and could therefore close or forge its own label;
- an inert renderer behind `--out`, writing one labelled transcript per
  scenario into a directory outside the input tree, refusing to overwrite any
  file that does not start with its own generated banner;
- explicit limits on file bytes, scenarios, segments, segment characters,
  markers per segment and findings, each enforced, each reported by name, and
  each reachable from the command line;
- a clean example that exits 0 and a broken one that exits 1, differing only in
  the policy file;
- the rule catalog, the two document formats, the limits and the determinism
  guarantee in `docs/fixture-rules.md`.

### Guarded

These are the defects this package was built against rather than audited for,
each with a test that fails when the guard is removed.

- **Unknown is never a pass.** A scan stopped by `maxMarkersPerSegment`, or a
  segment over `maxSegmentChars`, leaves the scenario unevaluated and the run
  `incomplete`. It does not compare the expected values against half a
  transcript, and it does not report the requests it never reached as absent --
  `test/incomplete.test.mjs` plants the challenge behind the cut-off and asserts
  both that nothing is claimed and that the same fixture passes with the limit
  raised.
- **No vacuous pass.** An empty scenario list, and a run in which nothing could
  be scanned, are errors that mark the run incomplete rather than `pass` with
  `checked: 0`.
- **Severity pinned behaviourally.** Every rule has a runnable case in
  `test/rule-cases.mjs` driven through the real binary; an error rule demoted to
  `warning` makes its run exit 0 and fails the case, whatever the source table
  and the documentation say.
- **Ordering pinned behaviourally.** `test/ordering.test.mjs` uses inputs an
  English collator orders the other way round -- `Z` before `a`, `README` before
  `assets`, `a-b` before `a_b` -- and asserts the emitted order. Substituting
  `Intl.Collator` for the code-unit comparator fails a test rather than silently
  making the output depend on a Node build's ICU data.
- **Sanitisation covers identifiers, not just excerpts.** C0, DEL, C1,
  U+2028/U+2029 and the bidi controls are stripped from every string that
  reaches output, and the tests drive each class in through a JSON *key* as well
  as through text -- a sibling tool sanitised its evidence carefully and let a
  record id forge whole lines.
- **The JSON parse diagnostic never reproduces the document.** The quoting shape
  is recognised before the offset, with the `s` flag, and a surviving double
  quote falls back to a generic sentence. Pinned on the document that reads
  `at position 1`, a credential-shaped document, a long document with a
  sensitive prefix, a quoted span containing a newline, a window taken from the
  middle of a document, and the safe positional form still yielding position,
  line and column.
- **Confinement is by real path.** A symbolic link planted inside the root is
  refused unread, including one whose target does not exist; a root that is
  itself reached through a link is not falsely refused.

No release has been published.
