# Instantly CRM

A minimal web CRM that syncs with your Instantly workspace and lets you reply to leads with AI-generated, human-sounding emails.

## Features

- **Auto-sync** — pulls campaigns, leads, emails, replies, and lead history from the Instantly API on an interval (default every 5 min) plus a manual "Sync now" button.
- **Leads organized by campaign** — filter by status (**Needs Reply / Follow Up / Appointment / Done**), priority, date range, and search; sortable.
- **Campaign setup** — per-campaign context: offer, ICP, tone, FAQs, notes.
- **AI replies** — generates a realistic draft using the campaign context + full conversation. You review, edit, refine ("shorter", "more casual", …), then **Send** — it goes out through Instantly as a reply to the lead's email.
- **Auto status tracking** — new replies are detected on sync and marked *Needs Reply*; sending a reply moves the lead to *Follow Up*; Instantly interest status (meeting booked, won, not interested…) maps to *Appointment / Done* automatically.
- **Dashboard** — counts for each status plus lists of leads needing attention and recent activity.
- **Lead history** — full email thread, activity log, and status/priority management per lead.

## Requirements

- Node.js >= 22.5
- Instantly API key (Instantly → Settings → API Keys; needs `leads:read`, `emails:read`, `emails:create`, `campaigns:read` scopes)
- An OpenAI-compatible API key (used only to generate drafts). Defaults to [OpenCode Zen](https://opencode.ai/zen), but as of writing its free-tier models reject requests from outside OpenCode's own client ("free tier can only be used in OpenCode") — you'll need either a payment method on that account to use its paid models, or to point Settings → AI reply engine at a different OpenAI-compatible provider (OpenAI, Anthropic via a compatible proxy, Groq, etc.) with its own key and base URL.

## Run

```bash
npm install
npm start        # http://localhost:3000
```

Open the app, go to **Settings**, paste your Instantly and OpenAI keys, and hit **Sync now**. Then set up context on each campaign (Campaigns tab) — the AI uses it to write replies.

Keys are stored in the CRM's own database — an embedded local Postgres instance under `data/pg-data` by default, or your hosted Postgres/Supabase database if you set `DATABASE_URL`.

## Notes

- The sync fetches up to 20 pages of leads and 3 pages of emails per campaign per run (tunable via the `sync_leads_pages` / `sync_email_pages` settings keys) and respects the emails endpoint rate limit (20 req/min).
- The reply is sent via `POST /api/v2/emails/reply` to the last email in the lead's thread, from the sending account Instantly used for that thread.

## Test

Runs the full flow (sync, filters, dashboard, send, status management) against a mock Instantly API — no real keys needed:

```bash
node test/e2e.js
```

The suite runs against its own throwaway embedded Postgres (separate port and data
directory), so it never touches your real database.

## Deployment

Runs on Render (web service) backed by Supabase Postgres.

- Set `DATABASE_URL` to the Supabase connection string. This is required in any hosted
  environment — Render's filesystem is ephemeral, so the embedded-Postgres fallback
  would lose all data on every restart or redeploy.
- `APP_USERNAME` / `APP_PASSWORD` gate the login. Set a real password: the service URL
  is public, and the lead data behind it is personal information.
- Instantly and AI credentials do **not** need to be set as environment variables if
  they are already saved in the database's `settings` table — the app reads them from
  there. Environment variables only seed settings that aren't already present.
- Notifications need HTTPS, so push only works on the deployed site, not localhost.
- On Render's free plan the service sleeps after ~15 minutes idle. While asleep it
  can't run the sync interval, so new replies aren't detected and no notifications
  are sent. A paid instance is required for unattended reply alerts.