### Fixed

- Portfolio E*TRADE 401 token_rejected now propagates: the client drops the dead token from the store, invalidates the isolate cache, and surfaces a reconnect signal instead of re-serving the rejected token on every load (#2441).
