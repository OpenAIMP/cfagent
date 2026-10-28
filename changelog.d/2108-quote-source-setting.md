### Added

- Quote source setting (#2108, slice C of the quotes consolidation): a deployment-wide Auto / Alpaca / Yahoo pick, stored in D1 and honored by the background refresh on both the WebSocket stream and the HTTP fallback, with a control on the ticker tape's feed badge. A pick takes effect immediately (a cached tick from the other source does not satisfy it); an Alpaca pick never substitutes Yahoo data.
