### Screener follow-up report links are absolute (#1943)

- Follow-up outcome report URLs are now built absolute (APP_BASE_URL, fallback https://agent.openaimp.com) via a shared helper, so Slack messages carry clickable report links instead of bare relative paths.
