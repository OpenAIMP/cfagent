### Goal screen

- **Persisted gather for the goal stock leg (#1998):** thesis filters (RSI, momentum) no longer refuse on the goal leg when the `goal_workflow` flag is on — the listing-feed screen enriches through a persisted gather (batch live quotes + technicals batch, one `mas_data_captures` row per symbol, gates evaluate the read-back rows), with honest missing-data rejections and a `goal.gather.stored` stage event.
