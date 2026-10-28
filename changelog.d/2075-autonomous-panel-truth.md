### Fixed

- **Autonomous Screen panel now states true information (#2075):** removed
  the unprovable "every 5 min" cadence claim (no 5-minute job exists — the
  finest worker tick is 30 minutes and the panel itself polls every 60
  seconds); every universe card and history row now carries the run's real
  trigger (Manual / Scheduled) instead of presenting manual runs as
  autonomous ones; the section states the 20-run retention cap and the
  60-second refresh; and one caption defines the counts (scanned = symbols
  evaluated, matched = passed the screen's filters, standout = flagged
  opportunities). See #2075.
