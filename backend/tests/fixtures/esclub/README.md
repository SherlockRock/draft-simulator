# esclub fixtures (anonymised)

Real replies from esclub.gg's guest websocket, recorded on 2026-11-12 (33
requests in all, logged in the night's reports) and anonymised by
`scripts/esclub/anonymize-fixtures.mjs` before commit. The raw replies are not
in the repo and never should be: they hold real players' Riot IDs.

Each file is `{ request, context, reply }`: the request name, the context sent,
and the reply payload's `context`.

- Season `11f1bc5f-4b33-e263-9b1e-aa8ed4a49d2d`, its stage list, the
  "Regular Season" stage, its round, the round's group, the group's series
  (45, from a `null` cursor), the stage's team rosters, and the LoL game
  resources (champions by Riot key, and the two Side resources), and one
  roster's schedule of played series (21, groups and bracket rounds).
- `group-bo3/`: a finished 2–0 Bo3 under a Group (CoinToss side selection,
  Riot IDs present). Game 0's red roster drafted Xin Zhao and the participant
  played Vi.
- `bracket-bo3/`: a finished Bo3 under a Round (HighestSeed / JustLost side
  selection, no PickSide rows, Riot IDs null), with its round and the round's
  series.

Replaced, consistently across files: `id_oauth_riot` (same player → same
fake), `name_riot_game` / `tag_riot` (`PlayerNN` / `TNN`, null kept),
`key_encryption`, the Riot match `id_game`, and `code_tournament` when set.
Team names, acronyms, colours and esclub ids are public and kept.

Tests never open a connection; they replay these through a fake socket.
