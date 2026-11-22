#!/bin/sh
# Captivo Access in-stack scheduler. Fires the manager's cron endpoints on an
# interval (site-health every 5 min; access reviews hourly; retention + anchor once a day) over the
# internal Docker network — no host crontab, no public round-trip.
BASE="${MANAGER_URL:-http://access-manager:3100}"

if [ -z "${CRON_SECRET:-}" ]; then
  echo "cron: CRON_SECRET is not set — refusing to start" >&2
  exit 1
fi

hit() {
  if curl -fsS -X POST -H "Authorization: Bearer ${CRON_SECRET}" "$BASE/api/cron/$1" -o /dev/null; then
    echo "cron: $1 ok"
  else
    echo "cron: $1 failed" >&2
  fi
}

DAILY_EVERY=288   # 288 * 5 min = 24 h
i=0
sleep 20          # let the manager finish starting on a cold boot
while true; do
  hit site-health
  # Access reviews: open, remind, close on their dates. Hourly is precise enough.
  if [ $((i % 12)) -eq 0 ]; then
    hit access-reviews
  fi
  if [ "$i" -eq 0 ]; then
    hit audit-retention
    hit recording-retention
    hit audit-anchor
  fi
  i=$(( (i + 1) % DAILY_EVERY ))
  sleep 300
done
