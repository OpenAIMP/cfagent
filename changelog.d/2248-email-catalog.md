### Fixed

- **Screener failure emails render from the error catalog (#2248):** the failure notification leg now renders SCREEN_001 via `codedMessage` instead of a hand-built literal, so the failure email (notify subject = first line, body = full text with the trace block) and the Slack failed leg carry the same catalog message. The success-subject function is unchanged (it is the success path only), and the notify 120-character subject derivation is unchanged. This intentionally supersedes the #2216 byte-identical pin for the failed leg; trace behavior is preserved.
