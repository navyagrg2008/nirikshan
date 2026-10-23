#!/usr/bin/env bash
# Backup restore drill (runbook 2). Dumps a database, encrypts the dump, decrypts it, restores into a scratch database, then checks:
#   1. every table has the same number of rows as the source,
#   2. the audit hash chain is intact in the restored copy,
#   3. the chain check really does notice a changed row (on a throwaway copy of the restore).
# Usage: scripts/restore-drill.sh [source_db=nrk_dev] [host=127.0.0.1] [port=5545] [user=postgres]
# Needs: pg_dump, pg_restore, psql, openssl. Writes nothing outside /var/tmp/nrk-drill. The source database is only read.
set -euo pipefail
SRC="${1:-nrk_dev}"; H="${2:-127.0.0.1}"; PORT="${3:-5545}"; U="${4:-postgres}"; W=/var/tmp/nrk-drill; mkdir -p "$W"; rm -f "$W"/*
PSQL="psql -h $H -p $PORT -U $U -v ON_ERROR_STOP=1 -tA"; now() { date +%s.%N; }
KEY="$(openssl rand -hex 32)"      # in real life this key lives with the backup owner, not next to the dump
t0=$(now); pg_dump -h "$H" -p "$PORT" -U "$U" --format=custom --no-owner "$SRC" -f "$W/dump.pgc"; t1=$(now)
openssl enc -aes-256-cbc -pbkdf2 -salt -pass "pass:$KEY" -in "$W/dump.pgc" -out "$W/dump.pgc.enc"; rm "$W/dump.pgc"
openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:$KEY" -in "$W/dump.pgc.enc" -out "$W/dump.restored.pgc"
echo "dump: $(printf '%.1f' "$(echo "$t1 - $t0" | bc)") s, encrypted size $(du -h "$W/dump.pgc.enc" | cut -f1)"
for db in nrk_restore nrk_restore_tamper; do $PSQL -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db" >/dev/null; done
t2=$(now); pg_restore -h "$H" -p "$PORT" -U "$U" --no-owner --dbname=nrk_restore "$W/dump.restored.pgc" 2>"$W/restore.err" || true; t3=$(now)
echo "restore: $(printf '%.1f' "$(echo "$t3 - $t2" | bc)") s; restore warnings: $(grep -c . "$W/restore.err" || true) lines (see $W/restore.err)"
rows() { $PSQL -d "$1" -c "SELECT format('%I', c.relname) || '|' || (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1"; }
rows "$SRC" > "$W/rows.src"; rows nrk_restore > "$W/rows.restored"
if diff -q "$W/rows.src" "$W/rows.restored" >/dev/null; then echo "PASS row counts match on $(wc -l < "$W/rows.src") tables ($(awk -F'|' '{s+=$2} END{print s}' "$W/rows.src") rows)"; else echo "FAIL row counts differ:"; diff "$W/rows.src" "$W/rows.restored" | head; exit 1; fi
chain() { $PSQL -d "$1" -c "SELECT 'checked=' || checked || ' first_bad=' || COALESCE(first_bad_id::text,'none') FROM audit_verify_chain()"; }
echo "source chain:   $(chain "$SRC")"; R="$(chain nrk_restore)"; echo "restored chain: $R"; case "$R" in *first_bad=none) echo "PASS audit chain intact after restore";; *) echo "FAIL audit chain"; exit 1;; esac
pg_restore -h "$H" -p "$PORT" -U "$U" --no-owner --dbname=nrk_restore_tamper "$W/dump.restored.pgc" 2>/dev/null || true
$PSQL -d nrk_restore_tamper -c "ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update" -c "UPDATE audit_events SET details = details || '{\"tampered\":true}'::jsonb WHERE id = (SELECT min(id) + 5 FROM audit_events)" >/dev/null
T="$(chain nrk_restore_tamper)"; echo "tampered chain: $T"; case "$T" in *first_bad=none) echo "FAIL the chain check did not notice the change"; exit 1;; *) echo "PASS the chain check notices a changed row";; esac
$PSQL -d postgres -c "DROP DATABASE nrk_restore" -c "DROP DATABASE nrk_restore_tamper" >/dev/null; rm -rf "$W"; echo "drill complete; scratch databases and files removed"
