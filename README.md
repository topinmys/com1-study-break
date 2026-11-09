# COM1 Study Break & Bubble Tea

[Live site](https://com1-study-break.vercel.app)

Mobile signup and organiser check-in for Computing Club Events Tech. Signups give food-order numbers; volunteers search names/IDs and hand over one cup at check-in.

**Event:** COM1 Foyer, Thursday, 7–9 PM. The calendar date is still unconfirmed.

## What it does

- Students register for one of 150 places. Each saved registration reserves one cup. Duplicate emails or student IDs are rejected; no walk-ins.
- Organisers enter a shared PIN, search by name or student ID, and tap **Check in & give cup**. Undo corrects mistakes.
- The organiser dashboard refreshes every five seconds.

## Scope

This first version covers signup, cup reservation and organiser check-in. Telegram messages, QR scanning, waitlists and student accounts are left out to keep the scope manageable and get the basic event flow working first.

## Why this setup

Plain HTML, CSS and JavaScript keep frontend setup small. Supabase hosts the shared database and backend code, so organisers on different phones see the same saved records. Its Edge Function handles requests and organiser PIN verification, while the database prevents duplicate registrations and enforces the 150-place limit. Vercel hosts the frontend website.

## How it works

The frontend runs in the browser. It sends registration and check-in requests to a Supabase Edge Function, which validates them and reads or saves records in the PostgreSQL database.

After the database confirms a save, the frontend updates the page. The organiser dashboard fetches updated records through the Edge Function every five seconds.

```text
frontend → edge function → database
frontend ← edge function ← result
```

## Testing

Automated tests cover registration limits, duplicate signups, organiser access, check-in and browser behaviour using temporary test data. Live capacity, organiser login/logout and the empty dashboard were checked without creating real registrations. Simultaneous requests competing for the final place have not been verified against the hosted database.

## Limitations

Registration and check-in require an internet connection. Email ownership is not verified, and the shared organiser PIN does not identify which volunteer performed a check-in.

## How I used AI

I used Codex to generate the code, automated tests and initial documentation, then revise them through discussion. I decided to include registration and organiser check-in and leave the Telegram bot for later. I reviewed the workflow and supplied the club logo. I spotted distorted straws and crowded login controls and asked Codex to fix them.
