const path = require('node:path');
const express = require('express');
const { query, getSetting, setSetting, logActivity, initSchema, markStaleDrafts } = require('./db');
const { api, runSync, INTEREST_LABELS, DEFAULT_BASE } = require('./instantly');
const { generateReply, deriveSenderName, ensureSignature } = require('./ai');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const STATUSES = ['needs_reply', 'follow_up', 'appointment', 'done'];
const PRIORITIES = ['high', 'normal', 'low'];
const INTEREST_TO_MY_STATUS = { 2: 'appointment', 3: 'appointment', 4: 'done', '-1': 'done', '-3': 'done', '-4': 'done' };

// ---- Login protection (built-in) ----
const AUTH_USER = process.env.APP_USERNAME || 'admin';
const AUTH_PASS = process.env.APP_PASSWORD;
const COOKIE = 'crm_auth';

function authOk(req) {
  if (!AUTH_PASS) return true; // auth disabled
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
  return cookie !== undefined && cookie.split('=')[1] === AUTH_PASS;
}
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!AUTH_PASS) return res.json({ ok: true });
  if (username === AUTH_USER && password === AUTH_PASS) {
    res.setHeader('Set-Cookie', `${COOKIE}=${AUTH_PASS}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', (req, res, next) => {
  if (!AUTH_PASS) return next();
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
  if (cookie && decodeURIComponent(cookie.split('=')[1]) === AUTH_PASS) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

function maskSecret(v) {
  if (!v) return '';
  return v.length <= 8 ? '*'.repeat(v.length) : `${v.slice(0, 4)}${'*'.repeat(v.length - 8)}${v.slice(-4)}`;
}

app.get('/api/state', async (req, res) => {
  try {
    res.json({
      settings: {
        instantly_api_key: maskSecret(await getSetting('instantly_api_key', '')),
        instantly_base_url: await getSetting('instantly_base_url', DEFAULT_BASE),
        openai_api_key: maskSecret(await getSetting('openai_api_key', '')),
        openai_base_url: await getSetting('openai_base_url', ''),
        openai_model: await getSetting('openai_model', 'gpt-4o-mini'),
        sender_first_name: await getSetting('sender_first_name', ''),
        sync_interval_min: await getSetting('sync_interval_min', '5'),
      },
      sync: {
        state: await getSetting('sync_state', 'idle'),
        progress: await getSetting('sync_progress', ''),
        error: await getSetting('sync_error', ''),
        last_sync_at: await getSetting('last_sync_at', ''),
        last_sync_summary: await getSetting('last_sync_summary', ''),
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings', async (req, res) => {
  const { instantly_api_key, instantly_base_url, openai_api_key, openai_base_url, openai_model, sender_first_name, sync_interval_min } = req.body || {};
  try {
    if (instantly_api_key) await setSetting('instantly_api_key', instantly_api_key.trim());
    if (instantly_base_url) await setSetting('instantly_base_url', instantly_base_url.trim());
    if (openai_api_key) await setSetting('openai_api_key', openai_api_key.trim());
    if (openai_base_url) await setSetting('openai_base_url', openai_base_url.trim());
    if (openai_model) await setSetting('openai_model', openai_model.trim());
    if (sender_first_name !== undefined) await setSetting('sender_first_name', String(sender_first_name).trim());
    if (sync_interval_min) {
      await setSetting('sync_interval_min', String(Math.max(1, parseInt(sync_interval_min, 10) || 5)));
      scheduleSync();
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sync', async (req, res) => {
  if ((await getSetting('sync_busy', '0')) === '1') return res.json({ ok: true, already_running: true });
  runSync().catch((err) => console.error('sync error:', err.message));
  res.json({ ok: true });
});

app.post('/api/test-connections', async (req, res) => {
  const results = {};
  try {
    const client = await api(await getSetting('instantly_base_url', DEFAULT_BASE));
    const { items } = await client.campaigns(1);
    results.instantly = { ok: true, detail: items && items.length ? `Connected — found ${items.length} campaign` : 'Connected (no campaigns)' };
  } catch (err) {
    results.instantly = { ok: false, detail: err.message };
  }
  try {
    const OpenAI = require('openai');
    const key = await getSetting('openai_api_key', '');
    if (!key) throw new Error('AI API key is not set. Add it in Settings.');
    const aiClient = new OpenAI({ apiKey: key, baseURL: await getSetting('openai_base_url', 'https://opencode.ai/zen/v1'), timeout: 45000 });
    const model = await getSetting('openai_model', 'hy3-free');
    const res2 = await aiClient.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    }, { timeout: 20000 });
    const text = (res2.choices && res2.choices[0].message.content || '').trim();
    results.ai = text ? { ok: true, detail: `AI model "${model}" responded` } : { ok: false, detail: `AI model "${model}" returned an empty response` };
  } catch (err) {
    results.ai = { ok: false, detail: err.message };
  }
  res.json({ results });
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const counts = { needs_reply: 0, follow_up: 0, appointment: 0, done: 0, untracked: 0 };
    for (const row of (await query('SELECT my_status, COUNT(*)::int AS n FROM leads GROUP BY my_status')).rows) {
      if (row.my_status && counts[row.my_status] !== undefined) counts[row.my_status] = row.n;
      else counts.untracked += row.n;
    }
    counts.replied = (await query('SELECT COUNT(*)::int AS n FROM leads WHERE reply_count > 0')).rows[0].n;
    const priorityCounts = {};
    for (const row of (await query('SELECT priority, COUNT(*)::int AS n FROM leads WHERE my_status = ANY($1::text[]) GROUP BY priority', [STATUSES.slice(0, 3)])).rows) {
      priorityCounts[row.priority] = row.n;
    }
    const attention = (await query(`
      SELECT id, email, first_name, last_name, company_name, campaign_id, my_status, priority, reply_count, last_reply_at, last_touch_at, next_touch_at
      FROM leads WHERE reply_count > 0 AND (my_status = ANY($1::text[]) OR my_status IS NULL)
      ORDER BY CASE my_status WHEN 'needs_reply' THEN 0 ELSE 1 END, COALESCE(last_reply_at, last_touch_at) DESC NULLS LAST LIMIT 50
    `, [['needs_reply', 'follow_up']])).rows;

    const nowIso = new Date().toISOString();
    const tomIso = new Date(Date.now() + 86400000).toISOString();
    const overdue = (await query("SELECT COUNT(*)::int AS n FROM leads WHERE next_touch_at IS NOT NULL AND next_touch_at < $1 AND my_status = 'follow_up'", [nowIso])).rows[0].n;
    const due_today = (await query("SELECT COUNT(*)::int AS n FROM leads WHERE next_touch_at IS NOT NULL AND next_touch_at < $1 AND next_touch_at >= $2 AND my_status = 'follow_up'", [tomIso, nowIso])).rows[0].n;
    const followups = { overdue, due_today };
    const followupsDue = (await query(`
      SELECT id, email, first_name, last_name, company_name, campaign_id, my_status, priority, next_touch_at
      FROM leads WHERE next_touch_at IS NOT NULL AND next_touch_at < $1 AND my_status = 'follow_up'
      ORDER BY next_touch_at ASC LIMIT 20
    `, [nowIso])).rows;
    const recentActivity = (await query(`
      SELECT a.*, l.email, l.first_name, l.last_name FROM activity_log a
      LEFT JOIN leads l ON l.id = a.lead_id ORDER BY a.timestamp DESC NULLS LAST LIMIT 12
    `)).rows;
    const campaignNames = {};
    for (const c of (await query('SELECT id, name FROM campaigns')).rows) campaignNames[c.id] = c.name;
    res.json({ counts, priorityCounts, attention, followups, followupsDue, recentActivity, campaignNames });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/campaigns', async (req, res) => {
  try {
    const campaigns = (await query('SELECT * FROM campaigns ORDER BY kind, name')).rows;
    const leadStats = (await query(`
      SELECT CASE WHEN campaign_id IS NOT NULL THEN campaign_id ELSE list_id END AS gid, COUNT(*)::int AS total,
        SUM(CASE WHEN my_status = 'needs_reply' THEN 1 ELSE 0 END)::int AS needs_reply,
        SUM(CASE WHEN my_status = 'follow_up' THEN 1 ELSE 0 END)::int AS follow_up,
        SUM(CASE WHEN my_status = 'appointment' THEN 1 ELSE 0 END)::int AS appointment
      FROM leads WHERE campaign_id IS NOT NULL OR list_id IS NOT NULL GROUP BY gid
    `)).rows;
    const stats = {};
    for (const s of leadStats) stats[s.gid] = s;
    res.json(campaigns.map((c) => ({ ...stripRaw(c), stats: stats[c.id] || null })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const campaign = (await query('SELECT * FROM campaigns WHERE id = $1', [req.params.id])).rows[0];
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json(stripRaw(campaign));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/campaigns/:id/context', async (req, res) => {
  const { offer, icp, tone, faqs, notes } = req.body || {};
  try {
    const r = await query(
      'UPDATE campaigns SET context_offer = $1, context_icp = $2, context_tone = $3, context_faqs = $4, context_notes = $5 WHERE id = $6',
      [offer || '', icp || '', tone || '', faqs || '', notes || '', req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/campaigns/:id/leads', async (req, res) => {
  try {
    const isAll = req.params.id === 'all';
    let group = null;
    if (!isAll) {
      group = (await query('SELECT * FROM campaigns WHERE id = $1', [req.params.id])).rows[0];
      if (!group) return res.status(404).json({ error: 'Campaign not found' });
    }
    const { my_status, priority, search, date_from, date_to, sort, limit, replied } = req.query;
    const where = [isAll ? '(campaign_id IS NOT NULL OR list_id IS NOT NULL)' : (group.kind === 'list' ? 'list_id = $1' : 'campaign_id = $1')];
    const params = isAll ? [] : [req.params.id];
    let arg = params.length;
    const bind = (v) => { arg++; params.push(v); return '$' + arg; };
    if (replied === '1') where.push('reply_count > 0');
    if (my_status === 'none') where.push('my_status IS NULL');
    else if (STATUSES.includes(my_status)) where.push('my_status = ' + bind(my_status));
    if (PRIORITIES.includes(priority)) where.push('priority = ' + bind(priority));
    if (search) {
      where.push('(email ILIKE ' + bind(`%${search}%`) + ' OR first_name ILIKE ' + bind(`%${search}%`) + ' OR last_name ILIKE ' + bind(`%${search}%`) + ' OR company_name ILIKE ' + bind(`%${search}%`) + ')');
    }
    if (date_from) where.push("GREATEST(COALESCE(last_reply_at, ''), COALESCE(last_contact_at, ''), COALESCE(last_touch_at, ''), COALESCE(updated_at, '')) >= " + bind(date_from));
    if (date_to) where.push("GREATEST(COALESCE(last_reply_at, ''), COALESCE(last_contact_at, ''), COALESCE(last_touch_at, ''), COALESCE(updated_at, '')) <= " + bind(/^\d{4}-\d{2}-\d{2}$/.test(date_to) ? date_to + 'T23:59:59.999Z' : date_to));
    const orderExpr = "GREATEST(COALESCE(last_reply_at, ''), COALESCE(last_contact_at, ''), COALESCE(last_touch_at, ''), COALESCE(updated_at, ''))";
    const sortMap = {
      last_touch_desc: orderExpr + ' DESC NULLS LAST',
      last_touch_asc: orderExpr + ' ASC NULLS LAST',
      last_reply_desc: 'last_reply_at IS NULL, last_reply_at DESC',
      name: 'first_name ASC NULLS FIRST, last_name ASC',
      company: 'company_name ASC',
    };
    const order = sortMap[sort] || sortMap.last_touch_desc;
    const n = Math.min(parseInt(limit, 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const total = (await query('SELECT COUNT(*)::int AS n FROM leads WHERE ' + where.join(' AND '), params)).rows[0].n;
    const rows = (await query('SELECT * FROM leads WHERE ' + where.join(' AND ') + ' ORDER BY ' + order + ' LIMIT ' + n + ' OFFSET ' + offset, params)).rows;
    res.json({ leads: rows.map(stripRaw), total, limit: n, offset });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leads/:id', async (req, res) => {
  try {
    const lead = (await query('SELECT * FROM leads WHERE id = $1', [req.params.id])).rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const campaign = (await query('SELECT * FROM campaigns WHERE id = $1', [lead.campaign_id || lead.list_id])).rows[0];
    const thread = (await query('SELECT * FROM emails WHERE lead_id = $1 ORDER BY timestamp IS NULL, timestamp ASC', [lead.id])).rows.map(stripRaw);
    const activity = (await query('SELECT * FROM activity_log WHERE lead_id = $1 ORDER BY timestamp DESC NULLS LAST LIMIT 50', [lead.id])).rows;
    const draft = (await query("SELECT * FROM drafts WHERE lead_id = $1 AND status = 'draft' ORDER BY created_at DESC NULLS LAST LIMIT 1", [lead.id])).rows[0];
    res.json({ lead: stripRaw(lead), campaign: campaign ? stripRaw(campaign) : null, thread, activity, draft: draft ? stripRaw(draft) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leads/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (status !== 'none' && !STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of ${STATUSES.join(', ')} or 'none'` });
  try {
    const lead = (await query('SELECT * FROM leads WHERE id = $1', [req.params.id])).rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (status === 'none') {
      await query('UPDATE leads SET my_status = NULL, manual_override = 1 WHERE id = $1', [lead.id]);
      await logActivity({ leadId: lead.id, campaignId: lead.campaign_id, type: 'status_change', detail: 'Lead untracked (manual)' });
      return res.json({ ok: true, untracked: true });
    }
    await query('UPDATE leads SET my_status = $1, manual_override = 1 WHERE id = $2', [status, lead.id]);
    await logActivity({ leadId: lead.id, campaignId: lead.campaign_id, type: 'status_change', detail: `Status changed to ${status} (manual)` });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leads/:id/interest', async (req, res) => {
  const { interest } = req.body || {};
  const key = String(interest);
  if (!(key in INTEREST_LABELS)) return res.status(400).json({ error: `Interest must be one of ${Object.keys(INTEREST_LABELS).join(', ')}` });
  try {
    const lead = (await query('SELECT * FROM leads WHERE id = $1', [req.params.id])).rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!lead.email) return res.status(400).json({ error: 'Lead has no email address' });
    const client = await api(await getSetting('instantly_base_url', DEFAULT_BASE));
    await client.updateInterestStatus({ leadEmail: lead.email, interestValue: parseInt(key, 10), campaignId: lead.campaign_id });
    const mapped = INTEREST_TO_MY_STATUS[key];
    await query('UPDATE leads SET interest_status = $1, my_status = COALESCE($2, my_status) WHERE id = $3', [parseInt(key, 10), mapped || null, lead.id]);
    await logActivity({ leadId: lead.id, campaignId: lead.campaign_id, type: 'interest_change', detail: `Interest set to ${INTEREST_LABELS[key]} (via Instantly)${mapped ? ` → status ${mapped}` : ''}` });
    res.json({ ok: true, my_status: mapped || lead.my_status });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/leads/:id/priority', async (req, res) => {
  const { priority } = req.body || {};
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
  try {
    const lead = (await query('SELECT * FROM leads WHERE id = $1', [req.params.id])).rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    await query('UPDATE leads SET priority = $1 WHERE id = $2', [priority, lead.id]);
    await logActivity({ leadId: lead.id, campaignId: lead.campaign_id, type: 'priority_change', detail: `Priority set to ${priority}` });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leads/:id/follow-up', async (req, res) => {
  const { days, date, clear } = req.body || {};
  try {
    const lead = (await query('SELECT * FROM leads WHERE id = $1', [req.params.id])).rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    let nextTouch = null;
    if (clear) {
      nextTouch = null;
    } else if (typeof date === 'string' && date.trim()) {
      nextTouch = /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? date.trim() + 'T09:00:00.000Z' : date.trim();
    } else if (days) {
      nextTouch = new Date(Date.now() + (parseInt(days, 10) || 1) * 24 * 60 * 60 * 1000).toISOString();
    } else {
      return res.status(400).json({ error: 'Provide days, a date, or clear=true' });
    }
    await query('UPDATE leads SET next_touch_at = $1 WHERE id = $2', [nextTouch, lead.id]);
    await logActivity({ leadId: lead.id, campaignId: lead.campaign_id, type: 'followup_scheduled', detail: nextTouch ? `Follow-up scheduled for ${nextTouch.slice(0, 10)}` : 'Follow-up reminder cleared' });
    res.json({ ok: true, next_touch_at: nextTouch });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leads/bulk', async (req, res) => {
  const { ids, action, value } = req.body || {};
  if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Provide an array of lead ids' });
  if (!action) return res.status(400).json({ error: 'Provide an action (status, priority, follow_up)' });
  const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',');
  try {
    let changes = 0;
    let detail = '';
    if (action === 'status') {
      if (value !== 'none' && !STATUSES.includes(value)) return res.status(400).json({ error: 'Invalid status' });
      const r = value === 'none'
        ? await query(`UPDATE leads SET my_status = NULL, manual_override = 1 WHERE id IN (${placeholders})`, ids)
        : await query(`UPDATE leads SET my_status = $${ids.length + 1}, manual_override = 1 WHERE id IN (${placeholders})`, [...ids, value]);
      changes = r.rowCount; detail = `Bulk set status to ${value} on ${changes} leads`;
    } else if (action === 'priority') {
      if (!PRIORITIES.includes(value)) return res.status(400).json({ error: 'Invalid priority' });
      const r = await query(`UPDATE leads SET priority = $${ids.length + 1} WHERE id IN (${placeholders})`, [...ids, value]);
      changes = r.rowCount; detail = `Bulk set priority to ${value} on ${changes} leads`;
    } else if (action === 'follow_up') {
      const nextTouch = new Date(Date.now() + (parseInt(value, 10) || 3) * 24 * 60 * 60 * 1000).toISOString();
      const r = await query(`UPDATE leads SET next_touch_at = $${ids.length + 1} WHERE id IN (${placeholders})`, [...ids, nextTouch]);
      changes = r.rowCount; detail = `Scheduled follow-up in ${parseInt(value, 10) || 3}d for ${changes} leads`;
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }
    if (changes > 0) await logActivity({ type: 'bulk_action', detail });
    res.json({ ok: true, changes, detail });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/export', async (req, res) => {
  const statusWhere = {
    needs_reply: "my_status = 'needs_reply'",
    follow_up: "my_status = 'follow_up'",
    appointment: "my_status = 'appointment'",
    done: "my_status = 'done'",
    replied: 'reply_count > 0',
  }[req.query.status];
  const where = [statusWhere || '1=1'];
  const params = [];
  let arg = 0;
  const bind = (v) => { arg++; params.push(v); return '$' + arg; };
  if (req.query.priority && PRIORITIES.includes(req.query.priority)) where.push('priority = ' + bind(req.query.priority));
  if (req.query.replied === '1') where.push('reply_count > 0');
  const rows = (await query(`SELECT id, email, first_name, last_name, company_name, job_title, my_status, priority, reply_count, opened_count, clicked_count, last_reply_at, last_touch_at, next_touch_at FROM leads WHERE ${where.join(' AND ')} ORDER BY COALESCE(last_reply_at, last_touch_at, updated_at) DESC NULLS LAST`, params)).rows;
  const esc = (v) => { const s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const header = ['id', 'email', 'first_name', 'last_name', 'company_name', 'job_title', 'my_status', 'priority', 'reply_count', 'opened_count', 'clicked_count', 'last_reply_at', 'last_touch_at', 'next_touch_at'];
  const lines = [header.join(',')].concat(rows.map((r) => header.map((k) => esc(r[k])).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${req.query.status || 'all'}.csv"`);
  res.send(lines.join('\n'));
});

app.get('/api/analytics', async (req, res) => {
  const campaignId = req.query.campaign || null;
  const whereCamp = campaignId ? 'WHERE campaign_id = $1' : '';
  const params = campaignId ? [campaignId] : [];
  const whereEmail = campaignId ? 'WHERE campaign_id = $1' : '';
  try {
    const totalLeads = (await query(`SELECT COUNT(*)::int AS n FROM leads ${whereCamp}`, params)).rows[0].n || 0;
    const sent = (await query(`SELECT COUNT(*)::int AS n FROM emails ${whereEmail ? whereEmail + ' AND direction = $2' : 'WHERE direction = $1'}`, campaignId ? [campaignId, 'sent'] : ['sent'])).rows[0].n || 0;
    const received = (await query(`SELECT COUNT(*)::int AS n FROM emails ${whereEmail ? whereEmail + ' AND direction = $2' : 'WHERE direction = $1'}`, campaignId ? [campaignId, 'received'] : ['received'])).rows[0].n || 0;
    const replied = (await query(`SELECT COUNT(*)::int AS n FROM leads ${whereCamp ? whereCamp + ' AND reply_count > 0' : 'WHERE reply_count > 0'}`, params)).rows[0].n || 0;
    const openedCount = (await query(`SELECT COALESCE(SUM(opened_count), 0)::int AS n FROM leads ${whereCamp}`, params)).rows[0].n || 0;
    const clicked = (await query(`SELECT COALESCE(SUM(clicked_count), 0)::int AS n FROM leads ${whereCamp}`, params)).rows[0].n || 0;
    const byStatus = (await query(`SELECT my_status, COUNT(*)::int AS n FROM leads ${whereCamp} GROUP BY my_status`, params)).rows;
    let campaignName = 'All campaigns';
    if (campaignId) {
      const c = (await query('SELECT name FROM campaigns WHERE id = $1', [campaignId])).rows[0];
      campaignName = c ? c.name : 'All campaigns';
    }
    res.json({
      campaign: campaignId, campaignName,
      leads: totalLeads, sentEmails: sent, receivedEmails: received,
      replied: replied, replyRate: totalLeads ? +(replied / totalLeads * 100).toFixed(1) : 0,
      openRate: totalLeads ? +(openedCount / totalLeads * 100).toFixed(1) : 0,
      clickRate: totalLeads ? +(clicked / totalLeads * 100).toFixed(1) : 0,
      openedCount, clicked,
      byStatus,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function getReplyContext(leadId) {
  const lead = (await query('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
  if (!lead) throw new Error('Lead not found');
  const group = (await query('SELECT * FROM campaigns WHERE id = $1', [lead.campaign_id || lead.list_id])).rows[0];
  const campaign = group || { id: null, name: 'No campaign', kind: null, context_offer: '', context_icp: '', context_tone: '', context_faqs: '', context_notes: '' };
  const thread = (await query('SELECT * FROM emails WHERE lead_id = $1 ORDER BY timestamp IS NULL, timestamp ASC', [lead.id])).rows;
  let senderName = await getSetting('sender_first_name', '');
  if (!senderName) {
    const accounts = (await query("SELECT DISTINCT from_email FROM emails WHERE direction = 'sent' AND from_email LIKE '%@%' LIMIT 100")).rows.map((r) => r.from_email);
    senderName = deriveSenderName(accounts);
    if (senderName) await setSetting('sender_first_name', senderName);
  }
  return { lead, campaign, thread, senderName };
}

app.post('/api/leads/:id/draft', async (req, res) => {
  try {
    const ctx = await getReplyContext(req.params.id);
    const draft = await generateReply(ctx);
    const signed = ensureSignature(draft.body, ctx.senderName);
    await query("UPDATE drafts SET status = 'superseded' WHERE lead_id = $1 AND status = 'draft'", [req.params.id]);
    const r = await query(
      'INSERT INTO drafts (lead_id, subject, body, status, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [req.params.id, draft.subject, signed, 'draft', new Date().toISOString()]
    );
    res.json({ id: r.rows[0].id, subject: draft.subject, body: signed, priority: draft.priority, status: draft.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/drafts/:id/refine', async (req, res) => {
  const { instruction } = req.body || {};
  if (!instruction) return res.status(400).json({ error: 'Instruction is required' });
  try {
    const draft = (await query('SELECT * FROM drafts WHERE id = $1', [req.params.id])).rows[0];
    if (!draft || draft.status !== 'draft') return res.status(404).json({ error: 'Draft not found' });
    const ctx = await getReplyContext(draft.lead_id);
    const regenerated = await generateReply({
      ...ctx,
      instruction,
      draftText: `Subject: ${draft.subject}\nBody:\n${draft.body}`,
    });
    const signed = ensureSignature(regenerated.body, ctx.senderName);
    await query('UPDATE drafts SET subject = $1, body = $2, created_at = $3 WHERE id = $4',
      [regenerated.subject, signed, new Date().toISOString(), draft.id]);
    res.json({ id: draft.id, subject: regenerated.subject, body: signed, priority: regenerated.priority, status: regenerated.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/drafts/:id/send', async (req, res) => {
  try {
    const draft = (await query('SELECT * FROM drafts WHERE id = $1', [req.params.id])).rows[0];
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (draft.status === 'sent') return res.status(409).json({ error: 'This reply was already sent.' });
    if (draft.status !== 'draft') return res.status(400).json({ error: 'Draft is no longer active (superseded). Regenerate it first.' });
    const lead = (await query('SELECT * FROM leads WHERE id = $1', [draft.lead_id])).rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const thread = (await query('SELECT * FROM emails WHERE lead_id = $1 ORDER BY timestamp IS NULL, timestamp DESC', [lead.id])).rows;
    const lastReceived = thread.find((e) => e.direction === 'received');
    const lastEmail = thread[0];
    const replyToUuid = draft.reply_to || (lastReceived ? lastReceived.id : lastEmail ? lastEmail.id : null);
    if (!replyToUuid) {
      return res.status(400).json({ error: 'No email found to reply to. Add the lead to a campaign first.' });
    }
    const rawOf = (e) => { try { return e && e.raw ? JSON.parse(e.raw) : null; } catch { return null; } };
    const targetEmail = lastReceived || lastEmail;
    const account = draft.eaccount || (rawOf(targetEmail) || {}).eaccount;
    if (!account) return res.status(400).json({ error: 'No sending account found for this email thread.' });

    const client = await api(await getSetting('instantly_base_url', DEFAULT_BASE));
    const subject = (req.body && typeof req.body.subject === 'string' && req.body.subject.trim()) || draft.subject || `Re: ${lastEmail?.subject || ''}`;
    const body = (req.body && typeof req.body.body === 'string' && req.body.body.trim()) || draft.body;
    if (body !== draft.body || subject !== draft.subject) {
      await query('UPDATE drafts SET subject = $1, body = $2 WHERE id = $3', [subject, body, draft.id]);
    }
    await client.reply({ replyToUuid, eaccount: account, subject, body });
    await query('UPDATE drafts SET status = $1, sent_at = $2, eaccount = $3, reply_to = $4 WHERE id = $5',
      ['sent', new Date().toISOString(), account, replyToUuid, draft.id]);
    const nextStatus = ['appointment', 'done'].includes(lead.my_status) ? lead.my_status : 'follow_up';
    const followUpMs = (parseInt(await getSetting('followup_days', '3'), 10) || 3) * 24 * 60 * 60 * 1000;
    const nextTouch = new Date(Date.now() + followUpMs).toISOString();
    await query('UPDATE leads SET my_status = $1, last_contact_at = $2, last_touch_at = $3, next_touch_at = $4 WHERE id = $5',
      [nextStatus, new Date().toISOString(), new Date().toISOString(), nextTouch, lead.id]);
    await logActivity({ leadId: lead.id, campaignId: lead.campaign_id, type: 'reply_sent', detail: `Reply sent to ${lead.email} via ${account}. Follow-up scheduled for ${nextTouch.slice(0, 10)}.` });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/templates', async (req, res) => {
  try {
    const rows = (await query('SELECT * FROM templates ORDER BY updated_at DESC NULLS LAST')).rows;
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/templates', async (req, res) => {
  const { name, subject, body, campaign_id } = req.body || {};
  if (!name || !body) return res.status(400).json({ error: 'Template needs a name and a body' });
  const now = new Date().toISOString();
  try {
    const r = await query('INSERT INTO templates (name, subject, body, campaign_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [name, subject || '', body, campaign_id || null, now, now]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/templates/:id', async (req, res) => {
  try {
    const t = (await query('SELECT * FROM templates WHERE id = $1', [req.params.id])).rows[0];
    if (!t) return res.status(404).json({ error: 'Template not found' });
    const { name, subject, body, campaign_id } = req.body || {};
    await query('UPDATE templates SET name = $1, subject = $2, body = $3, campaign_id = $4, updated_at = $5 WHERE id = $6',
      [name ?? t.name, subject ?? t.subject, body ?? t.body, campaign_id ?? t.campaign_id, new Date().toISOString(), t.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/templates/:id', async (req, res) => {
  try {
    await query('DELETE FROM templates WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/drafts/:id', async (req, res) => {
  try {
    await query('DELETE FROM drafts WHERE id = $1 AND status = $2', [req.params.id, 'draft']);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function stripRaw(obj) {
  if (!obj) return obj;
  const { raw, ...rest } = obj;
  return rest;
}

const PORT = process.env.PORT || 3000;
let syncTimer = null;

async function seedSettingsFromEnv() {
  const map = {
    INSTANTLY_API_KEY: 'instantly_api_key',
    INSTANTLY_BASE_URL: 'instantly_base_url',
    OPENAI_API_KEY: 'openai_api_key',
    OPENAI_BASE_URL: 'openai_base_url',
    OPENAI_MODEL: 'openai_model',
    SENDER_FIRST_NAME: 'sender_first_name',
    FOLLOWUP_DAYS: 'followup_days',
  };
  for (const [envKey, settingKey] of Object.entries(map)) {
    if (process.env[envKey]) await setSetting(settingKey, String(process.env[envKey]).trim());
  }
}
async function scheduleSync() {
  if (syncTimer) clearInterval(syncTimer);
  const intervalMin = parseInt(await getSetting('sync_interval_min', '5'), 10) || 5;
  syncTimer = setInterval(() => {
    runSync().catch((err) => console.error('sync error:', err.message));
  }, intervalMin * 60 * 1000);
}
(async () => {
  try {
    await initSchema();
    await markStaleDrafts();
    await seedSettingsFromEnv();
    console.log('[db] schema ready');
  } catch (e) {
    console.error('[db] init failed:', e.message);
    process.exit(1);
  }
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Instantly CRM running at http://0.0.0.0:${PORT}`);
    scheduleSync();
    (async () => {
      if (await getSetting('instantly_api_key', '')) runSync().catch(() => {});
    })();
  });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\nPort ${PORT} is already in use. Another instance may already be running at http://127.0.0.1:${PORT}.\nSet a different port with: PORT=3001 npm start\n`);
    } else {
      console.error('Server error:', err.message);
    }
    process.exit(1);
  });
})();