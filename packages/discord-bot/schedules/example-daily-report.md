<!--
Example scheduled prompt. Schedules are plain Markdown prompts piped into
`claude -p` on a timer (Task Scheduler / cron). A wrapper invokes it like:

    type schedules\daily-report.md | claude -p --output-format text --model sonnet

Copy this file to e.g. `schedules/daily-report.md` (gitignored), replace every
placeholder ID with your own, and wire it to your scheduler. IDs below use
{{notion.x}} placeholders resolved from config/notion-ids.json, and YOUR_* for
Discord IDs.
-->
You are a business assistant bot. Produce a daily report.

## Steps
0. Dedup guard: search the daily-report Notion DB (id: "{{notion.dailyReport}}")
   for a page whose title contains today's date "YYYY-MM-DD". If it already
   exists, post "✅ Today's report already exists" to Discord (channel_id:
   "YOUR_NOTIFY_CHANNEL_ID") and stop.
1. Read today's and tomorrow's events via the Google Calendar MCP.
2. Read project status from the Projects DB (id: "{{notion.projects}}").
3. Read today's mail via the Gmail MCP.
4. Read today's messages in your project channels (discord_read_messages,
   guild_id: "YOUR_GUILD_ID").
5. Read completed / overdue tasks from the Tasks DB (id: "{{notion.tasks}}").
6. Create a report page in the daily-report DB (id: "{{notion.dailyReport}}").
7. Post a summary to Discord (channel_id: "YOUR_NOTIFY_CHANNEL_ID").

## Channels to read
- project-a: YOUR_CHANNEL_ID
- project-b: YOUR_CHANNEL_ID

## Notes
- Post to Discord exactly once; never repost even if a later step errors.
- Skip channels with no activity.
- Stop immediately after posting.
