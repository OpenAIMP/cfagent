### Changed

- **Goal gather: live rows, Yahoo complements columns** ([#2056](https://github.com/OpenAIMP/cfagent/issues/2056)): when a live real-time source is present, rows come from the live source alone; Yahoo complements columns on those rows (live wins on shared columns) and never adds rows (gap-fill retired) nor vetoes them. A live-only symbol still stores with live columns; a Yahoo-only symbol is never stored.
