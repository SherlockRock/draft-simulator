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
# The SELECT runs ON THE SERVER through postgres_query, so only the selected
# rows cross the tailnet: DuckDB's own scan of pgdb.matches does not push the
# WHERE down — it opened 16 parallel COPY streams over the whole table and
# filtered locally (46 GB received for a 10 GB window on 2026-10-06), and
# without preserve_insertion_order=false it also buffered the whole result in
# RAM before writing (16.8 GB resident on a 19 GB machine). Keep both.
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

duckdb -c "
INSTALL postgres; LOAD postgres;
SET preserve_insertion_order = false;
SET memory_limit = '4GB';
ATTACH '$DB_URL' AS pgdb (TYPE postgres, READ_ONLY);
COPY (
  SELECT * FROM postgres_query('pgdb', '
    SELECT match_id, region, seed_tier, seed_division, queue_id, game_version,
           patch_major, patch_minor, game_duration, game_start,
           extractor_version, teams::text AS teams_json
    FROM matches
    WHERE status = ''fetched'' $PATCH_WHERE
  ')
) TO '$OUT' (FORMAT parquet, COMPRESSION zstd);
"

psql "$DB_URL" -qc "UPDATE matches SET exported_at = now() WHERE status = 'fetched' AND exported_at IS NULL $PATCH_WHERE"

ROWS=$(duckdb -noheader -list -c "SELECT count(*) FROM '$OUT'")
echo "export: $ROWS rows -> $OUT"
