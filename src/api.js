const INTERVAL_MINUTES = 15;
const CREATE_THRESHOLD_SECONDS = 5;

const COLLECTIONS = ['songs', 'setlists', 'albums'];

const COLLECTION_LABELS = {
  songs: { create: 'nová pieseň', update: 'pieseň aktualizovaná', createPlural: 'nové piesne', updatePlural: 'piesne aktualizované' },
  setlists: { create: 'nový setlist', update: 'setlist aktualizovaný', createPlural: 'nové setlisty', updatePlural: 'setlisty aktualizované' },
  albums: { create: 'nový album', update: 'album aktualizovaný', createPlural: 'nové albumy', updatePlural: 'albumy aktualizované' },
};

const APP_URL = process.env.BATCH_EMAIL_APP_URL || process.env.PUBLIC_URL?.replace(/\/+$/, '') || '';

function isNewRecord(record) {
  if (!record.date_created || !record.date_updated) return false;
  const created = new Date(record.date_created).getTime();
  const updated = new Date(record.date_updated).getTime();
  return Math.abs(updated - created) < CREATE_THRESHOLD_SECONDS * 1000;
}

/**
 * Build summary lines from grouped changes.
 * Returns array of { text, isNew } sorted: creates first, then updates.
 */
function buildChangeSummary(bandChanges) {
  const lines = [];

  for (const phase of ['create', 'update']) {
    for (const collection of COLLECTIONS) {
      const items = bandChanges[collection];
      if (!items) continue;
      const filtered = items.filter(r => phase === 'create' ? isNewRecord(r) : !isNewRecord(r));
      if (!filtered.length) continue;

      const labels = COLLECTION_LABELS[collection];
      const text = filtered.length === 1
        ? `${filtered.length} ${labels[phase]}`
        : `${filtered.length} ${labels[phase + 'Plural']}`;
      lines.push({ text, isNew: phase === 'create' });
    }
  }

  return lines;
}

/**
 * Build HTML email body.
 */
function buildEmailHtml(bandTitle, summaryLines) {
  const summaryHtml = summaryLines.map(l => {
    const color = l.isNew ? '#89ff49' : '#fff';
    return `<tr><td style="padding:6px 12px;border-bottom:1px solid #333;color:${color}">${l.text}</td></tr>`;
  }).join('');

  return `<div style="background:#1b1e1f;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:32px;max-width:520px;margin:0 auto">`
    + `<div style="text-align:center;margin-bottom:24px"><span style="font-size:24px;font-weight:bold;color:#fff">${bandTitle}</span></div>`
    + `<div style="background:#252829;border-radius:12px;padding:20px;margin-bottom:20px">`
    + `<p style="margin:0 0 12px;color:#aaa;font-size:13px;text-transform:uppercase;letter-spacing:1px">Zmeny za posledných ${INTERVAL_MINUTES} minút</p>`
    + `<table style="border-collapse:collapse;width:100%"><tbody>${summaryHtml}</tbody></table>`
    + `</div>`
    + `<div style="text-align:center;margin:24px 0"><a href="${APP_URL}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold">Otvoriť Spevník</a></div>`
    + `<hr style="border:none;border-top:1px solid #333;margin:24px 0">`
    + `<p style="color:#666;font-size:11px;text-align:center;margin:0">Tento email bol odoslaný automaticky z aplikácie Spevník.</p>`
    + `</div>`;
}

/**
 * Collect unique emails from band members and admins (non-archived).
 */
async function collectBandEmails(database, bandId) {
  const members = await database('members')
    .join('directus_users', 'members.user', 'directus_users.id')
    .where('members.band', bandId)
    .where('members.status', '!=', 'archived')
    .whereNotNull('directus_users.email')
    .select('directus_users.email');

  const admins = await database('admins')
    .join('directus_users', 'admins.user', 'directus_users.id')
    .where('admins.band', bandId)
    .where('admins.status', '!=', 'archived')
    .whereNotNull('directus_users.email')
    .select('directus_users.email');

  const emailSet = new Set([
    ...members.map(r => r.email),
    ...admins.map(r => r.email),
  ]);

  return [...emailSet];
}

export default {
  id: 'batch-email',
  handler: async (_opts, { database, logger, services, getSchema }) => {
    let schema;
    try {
      schema = await getSchema();
    } catch (err) {
      logger.error(`[batch-email] Failed to get schema: ${err.message}`);
      return { success: false, reason: 'schema_error' };
    }

    const mailService = new services.MailService({ schema });

    const cutoff = new Date(Date.now() - INTERVAL_MINUTES * 60 * 1000).toISOString();

    try {
      // 1. Query changed items per collection, grouped by band
      const bandChanges = {};

      for (const collection of COLLECTIONS) {
        const rows = await database(collection)
          .where('date_updated', '>', cutoff)
          .whereNotNull('band')
          .select('id', 'band', 'date_created', 'date_updated');

        for (const row of rows) {
          if (!bandChanges[row.band]) bandChanges[row.band] = {};
          if (!bandChanges[row.band][collection]) bandChanges[row.band][collection] = [];
          bandChanges[row.band][collection].push(row);
        }
      }

      const bandIds = Object.keys(bandChanges).map(Number);
      if (!bandIds.length) {
        logger.info('[batch-email] No changes in last interval');
        return { success: true, sent: 0 };
      }

      // 2. Load bands with email_notifications config
      const bands = await database('bands')
        .whereIn('id', bandIds)
        .where('email_notifications', true)
        .select('id', 'title');

      if (!bands.length) {
        logger.info('[batch-email] No bands with email_notifications enabled');
        return { success: true, sent: 0 };
      }

      let totalSent = 0;
      let totalFailed = 0;

      for (const band of bands) {
        const changes = bandChanges[band.id];
        const summaryLines = buildChangeSummary(changes);
        if (!summaryLines.length) continue;

        const emails = await collectBandEmails(database, band.id);
        if (!emails.length) continue;

        const subject = `${band.title} — ${summaryLines.map(l => l.text).join(', ')}`;
        const html = buildEmailHtml(band.title, summaryLines);

        // Send to all recipients in parallel
        const sends = emails.map(email =>
          mailService.send({
            to: email,
            subject,
            html,
          })
          .then(() => ({ status: 'sent', email }))
          .catch(err => {
            logger.error(`[batch-email] Failed for ${email}: ${err.message}`);
            return { status: 'failed', email };
          })
        );

        const results = await Promise.allSettled(sends);

        for (const r of results) {
          const val = r.status === 'fulfilled' ? r.value : r.reason;
          if (val?.status === 'sent') totalSent++;
          else totalFailed++;
        }
      }

      logger.info(`[batch-email] Done: ${totalSent} sent, ${totalFailed} failed`);
      return { success: true, sent: totalSent, failed: totalFailed };
    } catch (error) {
      logger.error(`[batch-email] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  },
};
