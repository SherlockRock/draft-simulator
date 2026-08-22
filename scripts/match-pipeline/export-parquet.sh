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
set -euo pipefail

DB_URL="${DATABASE_URL:-postgresql://collector@forge.tail86c250.ts.net/firstpick_matches}"
OUT_DIR="${1:-data/training}"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/matches_$(date +%Y-%m-%d).parquet"

duckdb -c "
INSTALL postgres; LOAD postgres;
ATTACH '$DB_URL' AS pgdb (TYPE postgres, READ_ONLY);
COPY (
  SELECT match_id, region, seed_tier, seed_division, queue_id, game_version,
         patch_major, patch_minor, game_duration, game_start,
         extractor_version, teams::VARCHAR AS teams_json
  FROM pgdb.matches
  WHERE status = 'fetched'
) TO '$OUT' (FORMAT parquet, COMPRESSION zstd);
"

psql "$DB_URL" -qc "UPDATE matches SET exported_at = now() WHERE status = 'fetched' AND exported_at IS NULL"

ROWS=$(duckdb -noheader -list -c "SELECT count(*) FROM '$OUT'")
echo "export: $ROWS rows -> $OUT"
