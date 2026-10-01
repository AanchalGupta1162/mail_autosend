# mail-autosend

Sends personalized recruiter emails from an Excel sheet, paced evenly over a time window, via Gmail.

## How it works

You keep a sheet of rows (one recruiter per row). Each run:

1. **Checks for replies** — for every row already `Sent` and still within its follow-up budget, checks your inbox over IMAP for a reply to that email's thread; marks it `Replied` if found.
2. **Builds today's job list** — any never-sent row becomes an "initial" send; any `Sent` row with no reply where `FOLLOWUP_INTERVAL_DAYS` have passed since the last send becomes a "follow-up" send; rows that just exhausted `FOLLOWUP_MAX_COUNT` follow-ups with no reply are marked `Done`.
3. **Sends**, spaced evenly across `WINDOW_MINUTES` so Gmail doesn't see a burst — HTML email with `**bold**` markdown rendered as real bold, your signature appended, and (on initial emails only) your resume attached. Follow-ups are sent as `Re: <subject>` in the same thread as the original.
4. **Writes progress back** — `Status`, `Message ID` (initial only), `Last Sent At`, `Follow-up Count`, `Error` — immediately after every send, so an interrupted run loses nothing.
5. Exits when the job list is empty. There's no daemon or cron — you run it manually, e.g. once each morning in your 9–10am window; it figures out on its own what (if anything) needs to go out that day.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- `GMAIL_USER` / `GMAIL_APP_PASSWORD` — generate the app password at https://myaccount.google.com/apppasswords (requires 2-Step Verification). Also turn on **IMAP access** in Gmail settings (Settings → See all settings → Forwarding and POP/IMAP) so reply-checking works.
- `EXCEL_PATH` — path to your sheet (defaults to `./sample-recruiters.xlsx`).
- `WINDOW_MINUTES` — how long to spread sends across (default `60`).
- `DRY_RUN` — `true` logs what would be sent without actually emailing or checking replies or touching the sheet. Always test with this on first.
- `RESUME_PATH` — file attached to every initial email. Leave blank for no attachment.
- `SIGNATURE_PATH` — HTML file appended to the bottom of every email. Leave blank for no signature.
- `FOLLOWUP_INTERVAL_DAYS` / `FOLLOWUP_MAX_COUNT` — follow-up cadence.

## Sheet format

`EXCEL_PATH` can be an `.xlsx` workbook or a `.csv` file (chosen by extension; UTF-8, quoted fields, status written back to the same file). For `.xlsx`, the first sheet in the workbook needs these column headers (any order): `Company`, `Role`, `Person`, `Email`, `Subject`, `Mail Text`, `Follow-up Text`. Write `**like this**` in `Mail Text`/`Follow-up Text` for bold. Leave `Follow-up Text` blank on a row to never follow up on it. The app adds `Status`, `Message ID`, `Last Sent At`, `Follow-up Count`, `Error` columns itself if they're missing — those are app-owned, don't hand-edit them except to fix a `Failed` row before rerunning.

Generate a 5-row sample sheet to try it out:

```bash
npm run sample-sheet
```

This writes `sample-recruiters.xlsx` with 5 example rows (initial + follow-up text, bold markup included), all addressed to your own email so it's safe to test against.

## Running

```bash
npm start
```

With `DRY_RUN=true`, this just prints what it would send (no sheet writes, no IMAP connection). Once you've verified the output looks right, set `DRY_RUN=false` and run again to actually send.

If a row fails (bad address, Gmail error, etc.), it's marked `Failed` with the error message and the queue moves on — fix the row and run again later; it'll be picked up since it isn't `Sent`. If an IMAP reply-check fails (network blip), that row is just skipped for this run and retried next time — it's never incorrectly marked `Replied` or `Done` on an inconclusive check.

## Tests

```bash
npm test
```
