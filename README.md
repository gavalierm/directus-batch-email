# Directus Batch Email Notifications

Custom Directus 11+ operation extension that sends batched email notifications about recent content changes. Designed to run as a scheduled Flow — queries recent changes in songs, setlists, and albums, groups them by band, and sends a single summary email to all band members and admins.

## Features

- **Batched delivery** — aggregates changes over a configurable interval (default 15 min) into one email per band
- **Per-band opt-in** — only bands with `email_notifications = true` receive emails
- **Smart change detection** — distinguishes between newly created and updated items
- **Styled HTML emails** — dark-themed responsive email template with change summary
- **Parallel sending** — emails sent concurrently with individual error handling
- **Slovak labels** — notification text in Slovak (nová pieseň, setlist aktualizovaný, etc.)

## Requirements

- Directus 11+
- Email transport configured in Directus (SMTP, SES, etc.)
- Collections: `bands`, `songs`, `setlists`, `albums`, `members`, `admins`

## Installation

### Option A: Git source (recommended for updates)

```bash
cd /path/to/directus/extensions/
git clone git@github.com:gavalierm/directus-batch-email.git directus-operation-batch-email
```

Restart Directus to load the extension.

**To update:**

```bash
cd /path/to/directus/extensions/directus-operation-batch-email
git pull
```

Restart Directus.

### Option B: Manual copy

1. Copy `dist/api.js`, `dist/app.js`, and `package.json` to `extensions/directus-operation-batch-email/`
2. Restart Directus

### Option C: Docker

```dockerfile
FROM directus/directus:latest

USER root
RUN corepack enable
USER node

RUN mkdir -p /directus/extensions/directus-operation-batch-email
COPY dist/api.js /directus/extensions/directus-operation-batch-email/
COPY dist/app.js /directus/extensions/directus-operation-batch-email/
COPY package.json /directus/extensions/directus-operation-batch-email/
```

## Configuration

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BATCH_EMAIL_APP_URL` | No | `PUBLIC_URL` | URL for the "Open App" button in emails |

Directus email transport must be configured separately (`EMAIL_TRANSPORT`, `EMAIL_SMTP_*`, etc.).

### Example `.env`

```env
BATCH_EMAIL_APP_URL=https://yourapp.com
```

If `BATCH_EMAIL_APP_URL` is not set, the extension falls back to `PUBLIC_URL`.

## Directus Setup

### 1. Required fields on `bands` collection

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `email_notifications` | boolean | `false` | Enable batch email notifications for this band |
| `title` | string | — | Band name (used in email subject and body) |

### 2. Required fields on content collections

The operation queries `songs`, `setlists`, and `albums`. Each must have:

| Field | Description |
|-------|-------------|
| `band` | FK to `bands` (integer) |
| `date_created` | Timestamp (system field) |
| `date_updated` | Timestamp (system field) |

### 3. Junction tables for recipients

The operation reads email addresses from:

- **`members`** — junction table `bands ↔ directus_users` with fields: `user` (FK), `band` (FK), `status`
- **`admins`** — junction table `bands ↔ directus_users` with fields: `user` (FK), `band` (FK), `status`

Recipients are all members and admins with `status != 'archived'` who have an email address.

### 4. Create a scheduled Flow

In Directus Admin → Settings → Flows:

1. **Create new Flow**
   - Name: `Email: Batch notifications`
   - Trigger: **Schedule**
   - Cron: `*/15 * * * *` (every 15 minutes)
   - Status: Active

2. **Add operation**
   - Type: **Batch Email Notifications** (appears after extension is installed)
   - No configuration needed

## How It Works

```
Every 15 minutes (cron trigger):

1. Query songs, setlists, albums changed in last 15 min
2. Group changes by band
3. Load bands with email_notifications = true
4. For each band:
   a. Build change summary (creates vs updates)
   b. Collect emails from members + admins (non-archived)
   c. Send styled HTML email to all recipients
5. Report: X sent, Y failed
```

### Change detection

Items are classified as **created** or **updated** by comparing `date_created` and `date_updated`. If the difference is less than 5 seconds, the item is considered newly created.

### Email format

**Subject:** `Band Name — 1 nová pieseň, 2 setlisty aktualizované`

**Body:** Dark-themed HTML email with:
- Band name header
- Change summary table (green = new, white = updated)
- "Open App" button linking to your frontend
- Auto-generated footer

### Slovak labels

| Label (singular) | Plural | Type |
|-----------------|--------|------|
| nová pieseň | nové piesne | song created |
| pieseň aktualizovaná | piesne aktualizované | song updated |
| nový setlist | nové setlisty | setlist created |
| setlist aktualizovaný | setlisty aktualizované | setlist updated |
| nový album | nové albumy | album created |
| album aktualizovaný | albumy aktualizované | album updated |

## Development

```bash
npm install
npx directus-extension build
```

Watch mode:

```bash
npx directus-extension build --watch
```

## License

MIT
