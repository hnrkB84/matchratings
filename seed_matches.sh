#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3000"
TOKEN="secret123"
SEASON="2025/26"
COMP="SHL"

create() {
  local date="$1" opponent="$2" home="$3"
  echo "Skapar: $date  $( [ "$home" = "1" ] && echo 'HV71 -' || echo '- HV71' )  $opponent"
  curl -s -X POST "$BASE/api/admin/create-match" \
    -H "x-admin-token: $TOKEN" -H "Content-Type: application/json" \
    -d "{\"date\":\"$date\",\"opponent\":\"$opponent\",\"home\":$home,\"season\":\"$SEASON\",\"competition\":\"$COMP\",\"voting_open\":0}"
  echo -e "\n---"
}

echo "== September 2025 =="
create "2025-09-13" "Örebro"     1   # HV71 - Örebro
create "2025-09-16" "Växjö"      0   # Växjö - HV71
create "2025-09-18" "Brynäs"     1   # HV71 - Brynäs
create "2025-09-20" "Malmö"      0   # Malmö - HV71
create "2025-09-25" "Timrå"      1   # HV71 - Timrå
create "2025-09-27" "Frölunda"   1   # HV71 - Frölunda
create "2025-09-30" "Leksand"    1   # HV71 - Leksand

echo "== Oktober 2025 =="
create "2025-10-02" "Färjestad"  1   # HV71 - Färjestad
create "2025-10-04" "Linköping"  0   # Linköping - HV71
create "2025-10-09" "Luleå"      0   # Luleå - HV71
create "2025-10-11" "Skellefteå" 0   # Skellefteå - HV71
create "2025-10-16" "Djurgården" 1   # HV71 - Djurgården
create "2025-10-18" "Rögle"      1   # HV71 - Rögle
create "2025-10-23" "Frölunda"   0   # Frölunda - HV71
create "2025-10-25" "Rögle"      1   # HV71 - Rögle
create "2025-10-28" "Linköping"  0   # Linköping - HV71
create "2025-10-30" "Djurgården" 0   # Djurgården - HV71

echo "== November 2025 =="
create "2025-11-01" "Timrå"      0   # Timrå - HV71
create "2025-11-13" "Växjö"      1   # HV71 - Växjö
create "2025-11-15" "Leksand"    1   # HV71 - Leksand
create "2025-11-20" "Färjestad"  0   # Färjestad - HV71
create "2025-11-22" "Luleå"      1   # HV71 - Luleå
create "2025-11-27" "Örebro"     1   # HV71 - Örebro
create "2025-11-29" "Brynäs"     0   # Brynäs - HV71

echo "== December 2025 =="
create "2025-12-04" "Skellefteå" 1   # HV71 - Skellefteå
create "2025-12-06" "Malmö"      1   # HV71 - Malmö
create "2025-12-18" "Frölunda"   0   # Frölunda - HV71
create "2025-12-20" "Djurgården" 1   # HV71 - Djurgården
create "2025-12-26" "Örebro"     0   # Örebro - HV71
create "2025-12-28" "Rögle"      0   # Rögle - HV71
create "2025-12-30" "Malmö"      1   # HV71 - Malmö

echo "== Januari 2026 =="
create "2026-01-03" "Leksand"    0   # Leksand - HV71
create "2026-01-06" "Luleå"      0   # Luleå - HV71
create "2026-01-08" "Skellefteå" 0   # Skellefteå - HV71
create "2026-01-10" "Timrå"      1   # HV71 - Timrå
create "2026-01-15" "Färjestad"  1   # HV71 - Färjestad
create "2026-01-17" "Växjö"      0   # Växjö - HV71
create "2026-01-22" "Linköping"  1   # HV71 - Linköping
create "2026-01-24" "Brynäs"     1   # HV71 - Brynäs
create "2026-01-29" "Örebro"     0   # Örebro - HV71
create "2026-01-31" "Luleå"      1   # HV71 - Luleå

echo "== Februari 2026 =="
create "2026-02-05" "Skellefteå" 1   # HV71 - Skellefteå
create "2026-02-07" "Malmö"      0   # Malmö - HV71
create "2026-02-19" "Rögle"      0   # Rögle - HV71
create "2026-02-21" "Frölunda"   1   # HV71 - Frölunda
create "2026-02-26" "Djurgården" 0   # Djurgården - HV71
create "2026-02-28" "Timrå"      0   # Timrå - HV71

echo "== Mars 2026 =="
create "2026-03-05" "Linköping"  1   # HV71 - Linköping
create "2026-03-07" "Leksand"    0   # Leksand - HV71
create "2026-03-10" "Färjestad"  0   # Färjestad - HV71
create "2026-03-12" "Växjö"      1   # HV71 - Växjö
create "2026-03-14" "Brynäs"     0   # Brynäs - HV71

echo "Klart! Ovan ser du svar med {\"id\":N} för varje match."
