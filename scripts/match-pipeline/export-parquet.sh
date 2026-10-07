#!/usr/bin/env bash
# Parquet export for the training rig — runs on the dev machine, reaching the
# forge Postgres over the tailnet. Deliberately dumb and re-runnable: every run
# is a full snapshot of fetched matches; flattening to LoLDraftAI's wide-column
# shape belongs to the training-prep step (their prepare_data.py).
#
# Requires: duckdb CLI (with the postgres extension), psql.
#
#   ./export-parquet.sh [out_dir]
#   DATABASE_URL=... ./export-parquet.sh          # override the DB
#   EXPORT_MIN_PATCH=16.18 ./export-parquet.sh    # window: this patch and newer only
#
# EXPORT_MIN_PATCH exists because the collector keeps every patch it ever
# fetched (2.8M matches across five patches by 2026-10) while prepare.py's
# corpus is a window of the newest two or three; the windowed file is named
# matches_<date>.from-<patch>.parquet so the report says what it was built on.
# Two steps, both streaming (2026-10-06, after the collector outgrew RAM):
#   1. psql \copy ... TO STDOUT (FORMAT csv) -> a CSV next to the output. The
#      SELECT runs on the server, so only the selected rows cross the tailnet
#      and nothing is buffered. DuckDB's postgres extension was tried first and
#      failed both ways: its own scan of pgdb.matches does not push the WHERE
#      down (16 parallel COPY streams over the whole table, 46 GB received for
#      a 10 GB window) and buffers the result in RAM before writing (16.8 GB
#      resident on a 19 GB machine); postgres_query materialises the whole
#      result too (Out of Memory at a 4 GB limit, output file deleted).
#   2. duckdb read_csv (typed, no sniffing) -> zstd parquet, small row groups.
# The CSV is deleted once the parquet is written.
set -euo pipefail

DB_URL="${DATABASE_URL:-postgresql://collector@forge.tail86c250.ts.net/firstpick_matches}"
OUT_DIR="${1:-data/training}"
mkdir -p "$OUT_DIR"
MIN_PATCH="${EXPORT_MIN_PATCH:-}"
if [[ -n "$MIN_PATCH" ]]; then
  [[ "$MIN_PATCH" =~ ^[0-9]+\.[0-9]+$ ]] || { echo "EXPORT_MIN_PATCH must be MAJOR.MINOR, got '$MIN_PATCH'" >&2; exit 1; }
  MIN_MAJOR="${MIN_PATCH%%.*}"; MIN_MINOR="${MIN_PATCH##*.}"
  PATCH_WHERE="AND (patch_major > $MIN_MAJOR OR (patch_major = $MIN_MAJOR AND patch_minor >= $MIN_MINOR))"
  OUT="$OUT_DIR/matches_$(date +%Y-%m-%d).from-$MIN_PATCH.parquet"
else
  PATCH_WHERE=""
  OUT="$OUT_DIR/matches_$(date +%Y-%m-%d).parquet"
fi

CSV="${OUT%.parquet}.csv"
psql "$DB_URL" -qc "\\copy (SELECT match_id, region, seed_tier, seed_division, queue_id, game_version, patch_major, patch_minor, game_duration, game_start, extractor_version, teams::text AS teams_json FROM matches WHERE status = 'fetched' $PATCH_WHERE) TO '$CSV' WITH (FORMAT csv, HEADER)"
echo "csv: $(du -h "$CSV" | cut -f1) -> $CSV"

# threads=2: each reader thread holds its CSV chunk plus a row group of ~31 KB
# rows (teams_json); 16 threads ran out of memory at 6 GB on 2026-10-06.
duckdb -c "
SET preserve_insertion_order = false;
SET threads = 2;
SET memory_limit = '8GB';
COPY (
  SELECT * FROM read_csv('$CSV', header = true, quote = '\"', escape = '\"',
    columns = {
      'match_id': 'VARCHAR', 'region': 'VARCHAR', 'seed_tier': 'VARCHAR', 'seed_division': 'VARCHAR',
      'queue_id': 'INTEGER', 'game_version': 'VARCHAR', 'patch_major': 'INTEGER', 'patch_minor': 'INTEGER',
      'game_duration': 'INTEGER', 'game_start': 'TIMESTAMPTZ', 'extractor_version': 'INTEGER', 'teams_json': 'VARCHAR'
    })
) TO '$OUT' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 20000);
"
rm -f "$CSV"

psql "$DB_URL" -qc "UPDATE matches SET exported_at = now() WHERE status = 'fetched' AND exported_at IS NULL $PATCH_WHERE"

ROWS=$(duckdb -noheader -list -c "SELECT count(*) FROM '$OUT'")
echo "export: $ROWS rows -> $OUT"
