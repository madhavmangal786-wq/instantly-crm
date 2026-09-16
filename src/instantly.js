const { query, getSetting, setSetting, logActivity } = require('./db');

const DEFAULT_BASE = 'https://api.instantly.ai';
const EMAIL_RATE_LIMIT_MS = 3500;

async function fetchJson(base, apiKey, method, path, { body, params } = {}, retries = 3) {
  const url = new URL(path, base);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(90000),
      });
    } catch (err) {
      if (attempt < retries) {
        await sleep(2000 * Math.pow(2, attempt));
        continue;
      }
      throw new Error(`${method} ${path} failed: network error (${err.message})`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep((res.status === 429 ? 5000 : 2000) * Math.pow(2, attempt));
      continue;
    }
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const msg = json && (json.message || json.error) ? JSON.stringify(json.message || json.error) : `HTTP ${res.status}`;
      throw new Error(`${method} ${path} failed: ${msg}`);
    }
    return json || {};
  }
}

async function api(base = DEFAULT_BASE) {
  const key = await getSetting('instantly_api_key', '');
  if (!key) throw new Error('Instantly API key is not set. Add it in Settings.');
  return {
    async campaigns(limit = 100, startingAfter) {
      return fetchJson(base, key, 'GET', '/api/v2/campaigns', { params: { limit, starting_after: startingAfter } });
    },
    async leadLists(limit = 100, startingAfter) {
      return fetchJson(base, key, 'GET', '/api/v2/lead-lists', { params: { limit, starting_after: startingAfter } });
    },
    async leads(campaignId, { limit = 100, startingAfter, search, filter } = {}) {
      const body = { limit };
      if (campaignId) body.campaign = campaignId;
      if (startingAfter) body.starting_after = startingAfter;
      if (search) body.search = search;
      if (filter) body.filter = filter;
      return fetchJson(base, key, 'POST', '/api/v2/leads/list', { body });
    },
    async emails({ campaignId, lead, limit = 100, startingAfter, minTimestamp } = {}) {
      const params = { limit, campaign_id: campaignId, lead, starting_after: startingAfter, min_timestamp_created: minTimestamp };
      return fetchJson(base, key, 'GET', '/api/v2/emails', { params });
    },
    async reply({ replyToUuid, eaccount, subject, body }) {
      return fetchJson(base, key, 'POST', '/api/v2/emails/reply', {
        body: { reply_to_uuid: replyToUuid, eaccount, subject, body: { text: body } },
      });
    },
    async updateInterestStatus({ leadEmail, interestValue, campaignId }) {
      return fetchJson(base, key, 'POST', '/api/v2/leads/update-interest-status', {
        body: { lead_email: leadEmail, interest_value: interestValue, campaign_id: campaignId },
      });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function upsertCampaigns(items) {
  for (const c of items) {
    await query(`
      INSERT INTO campaigns (id, name, status, kind, raw, synced_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, status = EXCLUDED.status, kind = EXCLUDED.kind, raw = EXCLUDED.raw, synced_at = EXCLUDED.synced_at
    `, [c.id, c.name || c.campaign_name || 'Unnamed', c.status ?? null, 'campaign', JSON.stringify(c), new Date().toISOString()]);
  }
}

async function upsertLeadLists(items) {
  for (const l of items) {
    await query(`
      INSERT INTO campaigns (id, name, status, kind, raw, synced_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, status = EXCLUDED.status, kind = EXCLUDED.kind, raw = EXCLUDED.raw, synced_at = EXCLUDED.synced_at
    `, [l.id, l.name || l.list_name || 'Unnamed', l.status ?? null, 'list', JSON.stringify(l), new Date().toISOString()]);
  }
}

async function upsertLead(c, existing) {
  const payload = c.payload || {};
  const firstName = c.first_name ?? payload.firstName ?? null;
  const lastName = c.last_name ?? payload.lastName ?? null;
  const company = c.company_name ?? payload.companyName ?? null;
  const jobTitle = c.job_title ?? payload.jobTitle ?? null;
  await query(`
    INSERT INTO leads (
      id, email, first_name, last_name, company_name, job_title, campaign_id, list_id, status,
      interest_status, opened_count, reply_count, clicked_count,
      last_reply_at, last_contact_at, last_open_at, last_click_at, last_touch_at,
      payload_json, raw, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
      company_name = EXCLUDED.company_name, job_title = EXCLUDED.job_title,
      campaign_id = EXCLUDED.campaign_id, list_id = EXCLUDED.list_id,
      status = EXCLUDED.status, interest_status = EXCLUDED.interest_status,
      opened_count = EXCLUDED.opened_count, reply_count = EXCLUDED.reply_count, clicked_count = EXCLUDED.clicked_count,
      last_reply_at = EXCLUDED.last_reply_at, last_contact_at = EXCLUDED.last_contact_at,
      last_open_at = EXCLUDED.last_open_at, last_click_at = EXCLUDED.last_click_at,
      last_touch_at = EXCLUDED.last_touch_at, payload_json = EXCLUDED.payload_json,
      raw = EXCLUDED.raw, updated_at = EXCLUDED.updated_at
  `, [
    c.id, c.email, firstName, lastName, company, jobTitle, c.campaign ?? null, c.list_id ?? null, c.status ?? null,
    c.lt_interest_status ?? null,
    c.email_open_count ?? 0, c.email_reply_count ?? 0, c.email_click_count ?? 0,
    c.timestamp_last_reply ?? null, c.timestamp_last_contact ?? null, c.timestamp_last_open ?? null,
    c.timestamp_last_click ?? null, c.timestamp_last_touch ?? null,
    JSON.stringify(payload), JSON.stringify(c), new Date().toISOString()
  ]);
  if (existing && existing.interest_status !== (c.lt_interest_status ?? null) && c.lt_interest_status != null) {
    await logActivity({
      leadId: c.id,
      campaignId: c.campaign ?? null,
      type: 'interest_change',
      detail: `Interest changed from ${INTEREST_LABELS[existing.interest_status] || existing.interest_status || 'Lead'} to ${INTEREST_LABELS[c.lt_interest_status] || c.lt_interest_status}`,
    });
  }
  return existing ? null : c.id;
}

const INTEREST_LABELS = {
  0: 'Out of Office', 1: 'Interested', 2: 'Meeting Booked', 3: 'Meeting Completed', 4: 'Won',
  '-1': 'Not Interested', '-2': 'Wrong Person', '-3': 'Lost', '-4': 'No Show',
};

function computeMyStatus(leadRow, emailsByLead) {
  const interest = leadRow.interest_status;
  if (interest === 2 || interest === 3) return 'appointment';
  if (interest === 4 || interest === -1 || interest === -3 || interest === -4) return 'done';
  const thread = emailsByLead.get(leadRow.id);
  if (thread && thread.length > 0) {
    const last = thread[thread.length - 1];
    if (last.direction === 'received') return 'needs_reply';
    return 'follow_up';
  }
  if (leadRow.reply_count > 0) return 'needs_reply';
  return null;
}

async function updateLeadStatuses() {
  const leads = (await query('SELECT * FROM leads')).rows;
  const threads = new Map();
  const emails = (await query('SELECT * FROM emails ORDER BY timestamp ASC')).rows;
  for (const e of emails) {
    if (!threads.has(e.lead_id)) threads.set(e.lead_id, []);
    threads.get(e.lead_id).push(e);
  }
  const now = Date.now();
  for (const lead of leads) {
    if (lead.manual_override === 1) continue;
    const computed = computeMyStatus(lead, threads);
    if (computed) await query('UPDATE leads SET my_status = $1 WHERE id = $2', [computed, lead.id]);

    const engaged = (lead.reply_count > 0) || (lead.opened_count > 0) || (lead.clicked_count > 0);
    if (computed && computed !== 'done') {
      await query("UPDATE leads SET priority = 'high' WHERE id = $1 AND priority_manual = 0", [lead.id]);
      continue;
    }
    if (engaged) continue;
    const touch = lead.last_touch_at ? new Date(lead.last_touch_at).getTime() : now;
    const stale = now - touch > 3 * 24 * 60 * 60 * 1000;
    if (stale) await query("UPDATE leads SET priority = 'low' WHERE id = $1 AND priority = 'normal' AND priority_manual = 0", [lead.id]);
  }
}

const AUTO_REPLY_RE = /\b(out of office|auto[- ]?repl(?:y|ied)|automatic reply|i am (?:currently )?on (?:vacation|holiday)|i'm (?:currently )?on (?:vacation|holiday)|away from (?:my )?(?:desk|office))\b/i;
const AUTO_SENDER_RE = /^(no-?reply|donotreply|mailer[- ]?daemon)@/i;

function isAutoReply(e) {
  const subj = e.subject || '';
  const body = extractBodyText(e);
  return AUTO_REPLY_RE.test(subj + ' ' + body) || AUTO_SENDER_RE.test(e.from_address_email || '');
}

// Instantly returns some emails (notably outbound "sent" ones) as HTML-only, with
// no body.text at all — without this, those messages store as an empty string and
// show up blank in the thread (and vanish from the AI's context of what was said).
function htmlToText(html) {
  if (!html) return '';
  let t = String(html);
  t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li|tr)>/gi, '\n');
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;/g, "'").replace(/&quot;/gi, '"');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function extractBodyText(e) {
  const b = e.body || {};
  return b.text || (b.html ? htmlToText(b.html) : '') || e.content_preview || '';
}

async function upsertEmails(items) {
  const leadByEmail = new Map((await query('SELECT email, id FROM leads WHERE email IS NOT NULL')).rows.map((r) => [r.email, r.id]));
  const newReplies = [];
  let inserted = 0;
  for (const e of items) {
    let leadId = e.lead_id ?? null;
    if (!leadId && e.lead) leadId = leadByEmail.get(e.lead) ?? null;
    if (!leadId) leadId = leadByEmail.get(e.to_address_email_list) ?? null;
    const direction =
      e.ue_type === 1 || e.ue_type === 3 || e.ue_type === 4 ? 'sent'
      : e.ue_type === 2 ? 'received'
      : 'received';
    const ts = e.timestamp_email ?? e.timestamp_created;
    const existing = (await query('SELECT id FROM emails WHERE id = $1', [e.id])).rows[0];
    await query(`
      INSERT INTO emails (
        id, thread_id, lead_id, campaign_id, subject, body_text, direction, ue_type,
        from_email, to_email, is_unread, is_auto, timestamp, raw
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (id) DO NOTHING
    `, [
      e.id, e.thread_id ?? null, leadId, e.campaign_id ?? null, e.subject ?? '',
      extractBodyText(e), direction, e.ue_type ?? null,
      e.from_address_email ?? null, e.to_address_email_list ?? null, e.is_unread ?? 0,
      isAutoReply(e) ? 1 : 0, ts ?? null, JSON.stringify(e)
    ]);
    if (!existing) {
      inserted++;
      if (leadId && direction === 'received') newReplies.push({ leadId, email: e, ts });
    }
  }
  const backfill = !(await getSetting('last_sync_at', ''));
  for (const { leadId, email, ts } of newReplies) {
    if (!backfill) {
      const lead = (await query('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
      await logActivity({
        leadId,
        campaignId: email.campaign_id,
        type: 'reply_received',
        detail: `New reply from ${lead ? lead.email : 'lead'}: "${(email.subject || '').slice(0, 120)}"`,
        at: ts || new Date().toISOString(),
      });
    }
    await query("UPDATE leads SET priority = 'high' WHERE id = $1 AND priority_manual = 0", [leadId]);
  }
  return { newReplies, inserted };
}

async function syncRepliedLeadEmails(client, progress) {
  const cap = Math.min(parseInt(await getSetting('sync_replied_cap', '200'), 10) || 200, 500);
  const replied = (await query(`
    SELECT l.* FROM leads l
    WHERE l.reply_count > 0
      AND (l.last_email_fetch_at IS NULL OR l.last_email_fetch_at < COALESCE(l.last_reply_at, '1970-01-01'))
    ORDER BY l.last_reply_at DESC NULLS LAST
    LIMIT $1
  `, [cap])).rows;
  let fetched = 0;
  let added = 0;
  const newReplies = [];
  const now = new Date().toISOString();
  let idx = 0;
  for (const lead of replied) {
    idx++;
    try {
      const { items } = await client.emails({ lead: lead.email, limit: 100, minTimestamp: lead.last_email_fetch_at });
      const r = await upsertEmails(items);
      fetched += items.length;
      added += r.inserted;
      newReplies.push(...r.newReplies);
      progress({ email: lead.email, emails: items.length, remaining: replied.length - idx });
    } catch (err) {
      console.error(`[sync] thread fetch failed for ${lead.email}: ${err.message}`);
    }
    await query('UPDATE leads SET last_email_fetch_at = $1 WHERE id = $2', [now, lead.id]);
    await sleep(EMAIL_RATE_LIMIT_MS);
  }
  return { fetched, added, newReplies };
}

async function syncAllLeads(client, progress, scopeCampaignId) {
  let cursor;
  let total = 0;
  const pages = Math.min(parseInt(await getSetting('sync_leads_pages', '30'), 10) || 30, 100);
  const firstSync = !(await getSetting('last_sync_at', ''));
  const startedAt = Date.now();
  const timeBudgetMs = (parseInt(await getSetting('sync_leads_time_budget_min', '8'), 10) || 8) * 60 * 1000;
  for (let i = 0; i < pages; i++) {
    if (Date.now() - startedAt > timeBudgetMs) {
      console.warn(`[sync] Leads fetch exceeded ${Math.round(timeBudgetMs / 60000)}m budget at ${total} leads; stopping leads fetch.`);
      break;
    }
    const { items, next_starting_after } = await client.leads(scopeCampaignId || null, { startingAfter: cursor });
    const newIds = [];
    for (const c of items) {
      const existing = (await query('SELECT * FROM leads WHERE id = $1', [c.id])).rows[0];
      const isNew = await upsertLead(c, existing);
      if (isNew) newIds.push(c.id);
    }
    total += items.length;
    progress({ added: newIds.length, total });
    if (!firstSync && newIds.length > 0) {
      for (const id of newIds) {
        const lead = (await query('SELECT * FROM leads WHERE id = $1', [id])).rows[0];
        await logActivity({ leadId: id, campaignId: lead.campaign_id, type: 'lead_added', detail: 'New lead synced from Instantly' });
      }
    }
    if (!next_starting_after || items.length === 0) break;
    cursor = next_starting_after;
    await sleep(120);
  }
  return total;
}

async function syncEmailsForGroup(client, group, progress) {
  if (group.kind === 'list') return { total: 0, added: 0, newReplies: [] };
  const resumeKey = `email_resume_${group.id}`;
  let resume = null;
  try { resume = JSON.parse(await getSetting(resumeKey, '') || 'null'); } catch { resume = null; }
  let cursor = resume ? resume.cursor : null;
  const since = resume ? resume.since : await getSetting('last_sync_at', '');
  let total = 0;
  let added = 0;
  let more = false;
  const newReplies = [];
  const pages = Math.min(parseInt(await getSetting('sync_email_pages', '3'), 10) || 3, 10);
  for (let i = 0; i < pages; i++) {
    const { items, next_starting_after } = await client.emails({ campaignId: group.id, startingAfter: cursor, minTimestamp: since });
    const r = await upsertEmails(items);
    total += items.length;
    added += r.inserted;
    newReplies.push(...r.newReplies);
    progress({ total, added });
    if (!next_starting_after || items.length === 0) { more = false; break; }
    cursor = next_starting_after;
    more = true;
    await sleep(EMAIL_RATE_LIMIT_MS);
  }
  if (more) await setSetting(resumeKey, JSON.stringify({ cursor, since }));
  else await setSetting(resumeKey, '');
  return { total, added, newReplies };
}

async function syncLockedStale() {
  try {
    const startedAt = await getSetting('sync_started_at', '');
    if (!startedAt) return true;
    const maxMs = (parseInt(await getSetting('sync_max_minutes', '20'), 10) || 20) * 60 * 1000;
    return (Date.now() - new Date(startedAt).getTime()) > maxMs;
  } catch {
    return true;
  }
}

async function clearSyncLock() {
  await setSetting('sync_busy', '0');
  await setSetting('sync_state', 'idle');
  await setSetting('sync_error', '');
}

async function runSync() {
  if ((await getSetting('sync_busy', '0')) === '1') {
    if (await syncLockedStale()) {
      await clearSyncLock();
      await setSetting('sync_progress', 'Cleared a stalled previous sync, starting fresh…');
      console.warn('[sync] A previous sync was stalled; reset its lock and restarting.');
    } else {
      return { skipped: true };
    }
  }
  await setSetting('sync_busy', '1');
  await setSetting('sync_state', 'running');
  const started = new Date().toISOString();
  await setSetting('sync_started_at', started);
  try {
    const base = await getSetting('instantly_base_url', DEFAULT_BASE);
    const client = await api(base);
    const scopeCampaignId = await getSetting('sync_scope_campaign_id', '');
    const isFirstSync = !(await getSetting('last_sync_at', ''));

    await setSetting('sync_progress', 'Fetching campaigns…');
    const { items: campaignItems, next_starting_after } = await client.campaigns(100);
    await upsertCampaigns(scopeCampaignId ? campaignItems.filter((c) => c.id === scopeCampaignId) : campaignItems);
    let campaignCursor = next_starting_after;
    while (campaignCursor) {
      const page = await client.campaigns(100, campaignCursor);
      await upsertCampaigns(scopeCampaignId ? page.items.filter((c) => c.id === scopeCampaignId) : page.items);
      campaignCursor = page.next_starting_after;
      await sleep(120);
    }

    if (!scopeCampaignId) {
      await setSetting('sync_progress', 'Fetching lead lists…');
      const { items: listItems, next_starting_after: listCursor } = await client.leadLists(100);
      await upsertLeadLists(listItems);
      let cursor = listCursor;
      while (cursor) {
        const page = await client.leadLists(100, cursor);
        await upsertLeadLists(page.items);
        cursor = page.next_starting_after;
        await sleep(120);
      }
    }

    const groups = (await query('SELECT * FROM campaigns ORDER BY name')).rows;
    const listCount = groups.filter((g) => g.kind === 'list').length;
    const progressLabel = scopeCampaignId ? `Fetching leads (${groups[0]?.name || 'scoped campaign'})…` : 'Fetching leads (all campaigns + lists)…';

    await setSetting('sync_progress', progressLabel);
    const leadsTotal = await syncAllLeads(client, ({ added, total }) =>
      setSetting('sync_progress', `${progressLabel} ${total} so far`), scopeCampaignId
    );

    let emailsTotal = 0;
    let emailsAdded = 0;
    let campIdx = 0;
    const allNewReplies = [];
    for (const g of groups) {
      if (g.kind === 'list') continue;
      if (scopeCampaignId && g.id !== scopeCampaignId) continue;
      campIdx++;
      const label = `Campaign ${campIdx}/${groups.length - listCount}: ${g.name}`;
      await setSetting('sync_progress', `${label} — emails…`);
      const r = await syncEmailsForGroup(client, g, ({ total, added }) =>
        setSetting('sync_progress', `${label} — emails (${total}, ${added} new)`)
      );
      emailsTotal += r.total;
      emailsAdded += r.added;
      allNewReplies.push(...r.newReplies);
    }

    await setSetting('sync_progress', 'Fetching threads for leads who replied…');
    const replied = await syncRepliedLeadEmails(client, ({ email, emails, remaining }) =>
      setSetting('sync_progress', `Fetching threads for leads who replied… ${email} (${emails} emails, ${remaining} left)`)
    );
    emailsTotal += replied.fetched;
    emailsAdded += replied.added;
    allNewReplies.push(...replied.newReplies);

    // Never notify on the very first (backfill) sync — that would fire one push per
    // historical reply ever received, not just genuinely new ones.
    if (!isFirstSync && allNewReplies.length) {
      const leadIds = [...new Set(allNewReplies.map((r) => r.leadId).filter(Boolean))];
      if (leadIds.length) {
        const leadRows = (await query('SELECT id, first_name, email, company_name FROM leads WHERE id = ANY($1::text[])', [leadIds])).rows;
        require('./push').notifyNewReplies(leadRows).catch((err) => console.error('[push] notify failed:', err.message));
      }
    }

    await updateLeadStatuses();
    await query('DELETE FROM activity_log WHERE timestamp < $1', [new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()]);
    await setSetting('last_sync_at', new Date().toISOString());
    await setSetting('last_sync_summary', `${groups.length - listCount} campaigns, ${listCount} lists, ${leadsTotal} leads, ${emailsTotal} emails fetched (${emailsAdded} new)`);
    await setSetting('sync_state', 'idle');
    await setSetting('sync_error', '');
    return { campaigns: groups.length - listCount, lists: listCount, leads: leadsTotal, emails: emailsTotal };
  } catch (err) {
    await setSetting('sync_state', 'error');
    await setSetting('sync_error', err.message);
    throw err;
  } finally {
    await setSetting('sync_busy', '0');
    await setSetting('sync_started_at', '');
    if ((await getSetting('sync_state', '')) === 'idle') await setSetting('sync_progress', '');
  }
}

// One-time repair for emails stored before extractBodyText() handled HTML-only
// bodies: re-derive body_text from the already-stored raw payload, no re-fetch needed.
async function backfillHtmlBodies() {
  const { rows } = await query("SELECT id, raw FROM emails WHERE body_text IS NULL OR body_text = ''");
  let fixed = 0;
  for (const row of rows) {
    let raw;
    try { raw = JSON.parse(row.raw); } catch { continue; }
    const text = extractBodyText(raw);
    if (text) {
      await query('UPDATE emails SET body_text = $1 WHERE id = $2', [text, row.id]);
      fixed++;
    }
  }
  if (fixed) console.log(`[db] backfilled body text for ${fixed} email(s)`);
  return fixed;
}

module.exports = { api, runSync, updateLeadStatuses, clearSyncLock, syncLockedStale, backfillHtmlBodies, INTEREST_LABELS, DEFAULT_BASE };