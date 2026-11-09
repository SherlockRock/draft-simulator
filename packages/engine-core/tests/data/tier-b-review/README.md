# tier-b-review test data

Shared by the Rust tests (`tests/tier_b_review.rs`) and the Node tests of `tier-b:apply`. The Node side needs no Rust knowledge: everything is plain JSON in the fixture's own spelling.

## Files

- `labelled-position.json`: a copy of a role-map pair root (Blue pair at slot 9, Rumble already locked) carrying two verdict entries. Every vector below is against this position. The labels in it are made up.
- `fold-vectors.json`: a list of cases `{ name, note?, entries, blind, current, blind_pick?, current_pick?, lines?, revealed }`. `entries` is a `verdicts` array, complete and loadable. The expected values are what folding it must give.
- `refusal-vectors.json`: a list of cases `{ name, entries, field }`. Each `entries` array is something the loader refuses at the labelled position, naming `field`. It is the write contract: apply must check every entry it is about to write against the loader's rules and refuse the position (writing nothing) rather than write one of these, because a refused fixture breaks `cargo test` and drops the position from the run. A `field` starting `verdicts[` is the loader's own error; a bare name (`started`) is a missing field, reported by the JSON reader.

## Conventions

- **Absent key means not answered; `null` means "no view".** In an entry, `would_pick` absent leaves the own pick as it was; `null` replaces it with "no view". In the expected `blind_pick` / `current_pick`, an absent key means never answered, `null` means "no view", and an array is the pick. `lines` absent means the case does not pin lines (`[]` means none).
- **Picks.** At a pair root `would_pick` is a two-element array of champion ids; compare two picks **as sets** (the order written is not the order stored). At a single-pick root it is a plain string (`"Galio"`). Anything else at a root (a string at a pair root, an array at a single root, the same champion twice, an unknown id) is refused at `verdicts[i].would_pick`. All vectors here are against the pair root, so a single-root string is not exercised.
- **Option ids are taken verbatim** from the run JSON, never built in JS. Canonical order inside a pair is **byte order** of the ids: `KSante+Kaisa` is canonical, `Kaisa+KSante` is refused, and `localeCompare` would get it wrong. Roles in a comp come in the order top, jungle, mid, adc, support.
- **Lines fold** by the pair (option id, line text): the last write for each pair wins, and the resolved list is ordered by where that last write sits in the file. Two different line strings on one option are both kept. A line verdict is allowed only in a `scored` entry, and `line.line` is a string.
- **Folds.** `current` is the last label written for each option in any entry; `blind` is the last written in a `blind` entry; the own pick folds the same two ways. `revealed` is true when any entry is `scored` (per file here; the page's reveal is per draft).
- Entries are read in file order. A `blind` entry after a `scored` one is refused.
