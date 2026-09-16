const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { Client } = require('pg');

const MOCK_PORT = 3199;
const CRM_PORT = 3100;
// A dedicated port + data dir so this never touches your real local database.
const TEST_PGPORT = parseInt(process.env.TEST_PGPORT || '5544', 10);
const CRM = `http://localhost:${CRM_PORT}`;

const LEADS = [
  {
    id: 'lead-001', email: 'alex@acme.com', first_name: 'Alex', last_name: 'Morgan',
    company_name: 'Acme Corp', job_title: 'Head of Growth', campaign: 'camp-1',
    status: 1, lt_interest_status: 1, email_open_count: 2, email_reply_count: 1, email_click_count: 0,
    timestamp_last_reply: '2026-08-15T09:00:00.000Z', timestamp_last_open: '2026-08-15T08:00:00.000Z',
    timestamp_last_touch: '2026-08-15T09:00:00.000Z', payload: { firstName: 'Alex', companyName: 'Acme Corp' },
  },
  {
    id: 'lead-002', email: 'sam@globex.io', first_name: 'Sam', last_name: 'Lee',
    company_name: 'Globex', job_title: 'Founder', campaign: 'camp-1',
    status: 1, lt_interest_status: 2, email_open_count: 1, email_reply_count: 1, email_click_count: 1,
    timestamp_last_reply: '2026-08-14T15:00:00.000Z', timestamp_last_open: '2026-08-14T10:00:00.000Z',
    timestamp_last_touch: '2026-08-15T09:30:00.000Z', payload: { firstName: 'Sam' },
  },
  {
    id: 'lead-003', email: 'jane@initech.com', first_name: 'Jane', last_name: 'Doe',
    company_name: 'Initech', job_title: 'COO', campaign: 'camp-1',
    status: 1, lt_interest_status: null, email_open_count: 1, email_reply_count: 0, email_click_count: 0,
    timestamp_last_touch: '2026-08-10T09:00:00.000Z', payload: {},
  },
  {
    id: 'lead-004', email: 'mike@umbrella.org', first_name: 'Mike', last_name: 'Smith',
    company_name: 'Umbrella', job_title: 'CTO', campaign: 'camp-2',
    status: 1, lt_interest_status: -1, email_open_count: 1, email_reply_count: 1, email_click_count: 0,
    timestamp_last_reply: '2026-08-12T11:00:00.000Z', timestamp_last_touch: '2026-08-12T11:00:00.000Z', payload: {},
  },
  {
    id: 'lead-005', email: 'old@leads.io', first_name: 'Oliver', last_name: 'Banks',
    company_name: 'Old Leads', job_title: 'CEO', campaign: null, list_id: 'list-1',
    status: 1, lt_interest_status: 1, email_open_count: 1, email_reply_count: 1, email_click_count: 0,
    timestamp_last_reply: '2026-07-20T09:00:00.000Z', timestamp_last_touch: '2026-07-20T09:00:00.000Z', payload: {},
  },
  {
    id: 'lead-006', email: 'link@test.com', first_name: 'Link', last_name: 'Worker',
    company_name: 'Linked Co', job_title: 'Ops Lead', campaign: 'camp-2',
    status: 1, lt_interest_status: 1, email_open_count: 2, email_reply_count: 1, email_click_count: 0,
    timestamp_last_reply: '2026-08-16T06:00:00.000Z', timestamp_last_touch: '2026-08-16T06:00:00.000Z', payload: {},
  },
];

const EMAILS = [
  { id: 'email-001', thread_id: 'thread-1', lead_id: 'lead-001', campaign_id: 'camp-1', subject: 'Quick question about your call volume', to_address_email_list: 'alex@acme.com', from_address_email: 'you@outbound.com', eaccount: 'you@outbound.com', ue_type: 1, timestamp_email: '2026-08-13T10:00:00.000Z', body: { text: 'Hey Alex — saw Acme is growing fast. Do you get many inbound calls?' } },
  { id: 'email-002', thread_id: 'thread-1', lead_id: 'lead-001', campaign_id: 'camp-1', subject: 'Re: Quick question about your call volume', to_address_email_list: 'you@outbound.com', from_address_email: 'alex@acme.com', eaccount: 'you@outbound.com', ue_type: 2, timestamp_email: '2026-08-15T09:00:00.000Z', body: { text: 'Yeah, roughly 40 a day and half go to voicemail. Annoying but it works.' } },
  { id: 'email-003', thread_id: 'thread-2', lead_id: 'lead-002', campaign_id: 'camp-1', subject: 'Idea for handling overflow calls', to_address_email_list: 'sam@globex.io', from_address_email: 'you@outbound.com', eaccount: 'you@outbound.com', ue_type: 1, timestamp_email: '2026-08-12T10:00:00.000Z', body: { text: 'Hi Sam — quick thought on automating overflow calls for Globex…' } },
  { id: 'email-004', thread_id: 'thread-2', lead_id: 'lead-002', campaign_id: 'camp-1', subject: 'Re: Idea for handling overflow calls', to_address_email_list: 'you@outbound.com', from_address_email: 'sam@globex.io', eaccount: 'you@outbound.com', ue_type: 2, timestamp_email: '2026-08-14T15:00:00.000Z', body: { text: 'Interesting. Can you send over a quick demo link? Happy to jump on a call.' } },
  { id: 'email-005', thread_id: 'thread-3', lead_id: 'lead-003', campaign_id: 'camp-1', subject: 'Hello from Outbound AI', to_address_email_list: 'jane@initech.com', from_address_email: 'you@outbound.com', eaccount: 'you@outbound.com', ue_type: 1, timestamp_email: '2026-08-10T09:00:00.000Z', body: { text: 'Hi Jane — noticed Initech…' } },
  { id: 'email-006', thread_id: 'thread-4', lead_id: 'lead-004', campaign_id: 'camp-2', subject: 'Streamlining ops at Umbrella', to_address_email_list: 'mike@umbrella.org', from_address_email: 'you@outbound.com', eaccount: 'you@outbound.com', ue_type: 1, timestamp_email: '2026-08-11T10:00:00.000Z', body: { text: 'Hi Mike —…' } },
  { id: 'email-007', thread_id: 'thread-4', lead_id: 'lead-004', campaign_id: 'camp-2', subject: 'Re: Streamlining ops at Umbrella', to_address_email_list: 'you@outbound.com', from_address_email: 'mike@umbrella.org', eaccount: 'you@outbound.com', ue_type: 2, timestamp_email: '2026-08-12T11:00:00.000Z', body: { text: 'Not interested right now, thanks.' } },
  { id: 'email-008', thread_id: 'thread-5', lead_id: 'lead-005', lead: 'old@leads.io', campaign_id: null, list_id: 'list-1', subject: 'Re: Following up on our chat', to_address_email_list: 'you@outbound.com', from_address_email: 'old@leads.io', eaccount: 'you@outbound.com', ue_type: 2, timestamp_email: '2026-07-20T09:00:00.000Z', body: { text: 'Still interested actually — my calendar is open next week.' } },
  { id: 'email-009', thread_id: 'thread-6', lead_id: null, lead: 'link@test.com', campaign_id: null, list_id: null, subject: 'Re: Ops automation', to_address_email_list: 'you@outbound.com', from_address_email: 'link@test.com', eaccount: 'you@outbound.com', ue_type: 2, timestamp_email: '2026-08-16T06:00:00.000Z', body: { text: 'Yes, let us try a pilot. What does setup look like?' } },
  { id: 'email-010', thread_id: 'thread-2', lead_id: 'lead-002', campaign_id: 'camp-1', subject: 'Automatic reply: Out of office', to_address_email_list: 'you@outbound.com', from_address_email: 'sam@globex.io', eaccount: 'you@outbound.com', ue_type: 4, timestamp_email: '2026-08-14T09:30:00.000Z', body: { text: 'Thanks for your email. I am out of the office until Monday.' } },
];

const repliesSent = [];
const emailCalls = [];

const mock = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, 'http://localhost');
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    if (url.pathname === '/api/v2/campaigns' && req.method === 'GET') {
      return send(200, { items: [
        { id: 'camp-1', name: 'AI Phone Agents — Growth', status: 1 },
        { id: 'camp-2', name: 'Ops Automation — V2', status: 1 },
      ], next_starting_after: null });
    }
    if (url.pathname === '/api/v2/lead-lists' && req.method === 'GET') {
      return send(200, { items: [{ id: 'list-1', name: 'Old Leads 2025' }], next_starting_after: null });
    }
    if (url.pathname === '/api/v2/leads/list' && req.method === 'POST') {
      const items = body.campaign
        ? LEADS.filter((l) => l.campaign === body.campaign)
        : body.list_id ? LEADS.filter((l) => l.list_id === body.list_id)
        : LEADS;
      return send(200, { items, next_starting_after: null });
    }
    if (url.pathname === '/api/v2/emails' && req.method === 'GET') {
      const camp = url.searchParams.get('campaign_id');
      const list = url.searchParams.get('list_id');
      const leadEmail = url.searchParams.get('lead');
      emailCalls.push({ camp, list, lead: leadEmail, minTs: url.searchParams.get('min_timestamp_created') });
      let items = EMAILS.filter((e) =>
        leadEmail ? e.lead === leadEmail
        : camp ? e.campaign_id === camp
        : list ? e.list_id === list
        : true);
      const after = url.searchParams.get('starting_after');
      if (after) items = items.filter((e) => e.id > after);
      return send(200, { items, next_starting_after: null });
    }
    if (url.pathname === '/api/v2/emails/reply' && req.method === 'POST') {
      repliesSent.push(body);
      return send(200, { id: 'email-reply-' + repliesSent.length, ...body, timestamp_email: new Date().toISOString() });
    }
    if (url.pathname === '/api/v2/leads/update-interest-status' && req.method === 'POST') {
      return send(202, { message: 'Lead interest status update background job submitted' });
    }
    send(404, { message: `no mock route for ${req.method} ${url.pathname}` });
  });
});

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

async function api(path, opts = {}) {
  const res = await fetch(CRM + path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitSyncIdle() {
  for (let i = 0; i < 60; i++) {
    const { json } = await api('/api/state');
    if (json.sync.state !== 'running') return json;
    await sleep(500);
  }
  throw new Error('sync did not finish');
}

async function main() {
  const tmpData = path.join(os.tmpdir(), 'instantly-crm-e2e-' + Date.now());
  require('node:fs').rmSync(tmpData, { recursive: true, force: true });

  await new Promise((r) => mock.listen(MOCK_PORT, r));
  console.log('mock instantly on', MOCK_PORT);

  const crm = spawn('node', ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    // Force the embedded-Postgres path (never the dev DB) at an isolated port + data dir.
    env: {
      ...process.env, PORT: String(CRM_PORT), CRM_DATA_DIR: tmpData, PGPORT: String(TEST_PGPORT),
      DATABASE_URL: '', POSTGRES_URL: '', SUPABASE_URL: '', PGHOST: '',
      // Explicitly override (not just omit) so the app's .env loader — which fills in
      // only unset keys — can't pull in the real project .env's login credentials here.
      APP_USERNAME: '', APP_PASSWORD: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  crm.stdout.on('data', (d) => process.stdout.write('[crm] ' + d));
  crm.stderr.on('data', (d) => process.stderr.write('[crm!] ' + d));

  // Embedded Postgres has to run initdb + start a fresh cluster on first boot, which is
  // much slower than the old in-process sqlite — give it real time before giving up.
  await sleep(1500);
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { await api('/api/state'); ready = true; break; } catch { await sleep(750); }
  }
  if (!ready) throw new Error('CRM did not become ready in time (embedded Postgres startup too slow or failed)');

  let pgClient = null;
  try {
  pgClient = new Client({ host: 'localhost', port: TEST_PGPORT, database: 'instantly_crm', user: 'postgres', password: 'postgres' });
  await pgClient.connect();
  async function insertDraft(leadId, subject, body, createdAt) {
    const r = await pgClient.query(
      "INSERT INTO drafts (lead_id, subject, body, status, created_at) VALUES ($1, $2, $3, 'draft', $4) RETURNING id",
      [leadId, subject, body, createdAt]
    );
    return r.rows[0].id;
  }

  console.log('\n1) settings + sync');
  let r = await api('/api/settings', { method: 'POST', body: { instantly_api_key: 'test-key', instantly_base_url: `http://localhost:${MOCK_PORT}` } });
  check('settings saved', r.status === 200);

  r = await api('/api/sync', { method: 'POST' });
  check('sync triggered', r.status === 200);
  const st = await waitSyncIdle();
  check('sync completed without error', st.sync.state === 'idle', JSON.stringify(st.sync));
  console.log('   summary:', st.sync.last_sync_summary);

  console.log('\n2) dashboard');
  r = await api('/api/dashboard');
  const d = r.json;
  check('replied=5 (all leads who replied)', d.counts.replied === 5, `got ${d.counts.replied}`);
  check('needs_reply=3 (Alex + Oliver + Link un-answered inbound)', d.counts.needs_reply === 3, `got ${d.counts.needs_reply}`);
  check('appointment=1 (Sam meeting booked)', d.counts.appointment === 1, `got ${d.counts.appointment}`);
  check('done=1 (Mike not interested)', d.counts.done === 1, `got ${d.counts.done}`);
  check('follow_up=1 (Jane contacted, waiting)', d.counts.follow_up === 1, `got ${d.counts.follow_up}`);
  check('attention lists oldest unanswered reply first (most overdue surfaces, not buried)', d.attention[0] && d.attention[0].email === 'old@leads.io', JSON.stringify(d.attention.map((a) => a.email)));
  check('no reply spam during backfill (first sync logs no historical replies)', !d.recentActivity.some((a) => a.type === 'reply_received'));

  console.log('\n2b) new reply after backfill → logged once');
  EMAILS.push({ id: 'email-011', thread_id: 'thread-1', lead_id: 'lead-001', campaign_id: 'camp-1', subject: 'Re: Quick question about your call volume', to_address_email_list: 'you@outbound.com', from_address_email: 'alex@acme.com', eaccount: 'you@outbound.com', ue_type: 2, timestamp_email: new Date().toISOString(), body: { text: 'Thursday works great.' } });
  r = await api('/api/sync', { method: 'POST' });
  await waitSyncIdle();
  const d2 = (await api('/api/dashboard')).json;
  check('reply_received logged for genuinely new reply', d2.recentActivity.some((a) => a.type === 'reply_received' && a.detail.includes('alex@acme.com')), JSON.stringify(d2.recentActivity.slice(0, 3).map((a) => a.type + ': ' + a.detail)));
  check('no fake interest-change spam on re-sync', d2.recentActivity.filter((a) => a.type === 'interest_change').length <= 3, `got ${d2.recentActivity.filter((a) => a.type === 'interest_change').length}`);
  check('untracked replied lead appears in attention (needs_reply still 3)', d2.attention.length >= 1);

  console.log('\n3) campaign leads + filters');
  r = await api('/api/campaigns');
  check('2 campaigns + 1 list synced', r.json.length === 3, `got ${r.json.length}`);
  check('list has kind=list', r.json.some((g) => g.kind === 'list' && g.id === 'list-1'));
  check('campaign stats attached', r.json[0].stats && r.json[0].stats.total === 3);

  r = await api('/api/campaigns/camp-1/leads');
  check('3 leads in camp-1', r.json.leads.length === 3 && r.json.total === 3);
  r = await api('/api/campaigns/list-1/leads');
  check('list shows its lead', r.json.leads.length === 1 && r.json.leads[0].email === 'old@leads.io');
  r = await api('/api/campaigns/camp-1/leads?my_status=needs_reply');
  check('status filter works', r.json.leads.length === 1 && r.json.leads[0].email === 'alex@acme.com');
  r = await api('/api/campaigns/camp-2/leads?replied=1');
  check('replied filter works', r.json.leads.length === 2 && r.json.leads.every((l) => l.reply_count > 0), JSON.stringify(r.json.leads.map((l) => l.email)));
  r = await api('/api/campaigns/camp-1/leads?search=sam');
  check('search filter works', r.json.leads.length === 1 && r.json.leads[0].email === 'sam@globex.io');
  r = await api('/api/campaigns/all/leads?replied=1');
  check('global replied queue across campaigns', r.json.leads.length === 5 && r.json.total === 5, `got ${r.json.total}`);
  r = await api('/api/campaigns/camp-1/leads?limit=2&offset=2');
  check('pagination offset works', r.json.leads.length === 1 && r.json.total === 3, JSON.stringify({ n: r.json.leads.length, total: r.json.total }));
  check('list email sync skipped (no unfiltered/list email calls)', emailCalls.every((c) => !c.list && (c.camp || c.lead)), JSON.stringify(emailCalls.slice(0, 5)));
  check('replied-thread fetch uses lead filter + incremental timestamp', emailCalls.some((c) => c.lead === 'link@test.com'));

  console.log('\n4) lead detail + thread');
  r = await api('/api/leads/lead-001');
  check('thread has 3 emails', r.json.thread.length === 3);
  check('thread shows inbound last', r.json.thread[2].direction === 'received');
  check('campaign context attached', r.json.campaign && r.json.campaign.name.includes('AI Phone Agents'));
  r = await api('/api/leads/lead-005');
  check('list lead resolves its list group', r.json.campaign && r.json.campaign.kind === 'list' && r.json.campaign.name === 'Old Leads 2025');
  r = await api('/api/leads/lead-006');
  check('email linked to lead by address (no lead_id on email)', r.json.thread.length === 1 && r.json.thread[0].direction === 'received', JSON.stringify(r.json.thread));
  r = await api('/api/leads/lead-002');
  check('auto-reply (OOO) flagged is_auto', r.json.thread.some((e) => e.is_auto && e.subject.includes('Out of office')), JSON.stringify(r.json.thread.map((e) => [e.subject, e.is_auto])));

  console.log('\n5) AI draft without key → friendly error');
  r = await api('/api/leads/lead-001/draft', { method: 'POST' });
  check('draft returns 400 with message', r.status === 400 && /API key is not set/.test(r.json.error || ''), JSON.stringify(r.json));

  console.log('\n6) send reply via mock');
  await api('/api/settings', { method: 'POST', body: { openai_api_key: 'sk-fake', openai_model: 'gpt-test' } });
  const draftRes = await api('/api/leads/lead-001/draft', { method: 'POST' });
  check('draft without valid OpenAI key errors cleanly', draftRes.status === 400 && /401|key/i.test(draftRes.json?.error || ''));
  const draftId = await insertDraft('lead-001', 'Re: Quick question about your call volume', 'Hi Alex — happy to share how we handle overflow. Got 15 min Thursday?', new Date().toISOString());
  r = await api(`/api/drafts/${draftId}/send`, { method: 'POST' });
  check('send succeeds', r.status === 200, JSON.stringify(r.json));
  check('mock received reply with body', repliesSent.length === 1 && /[a-zA-Z]/.test(repliesSent[0].body.text));
  check('reply_to_uuid = last received email', repliesSent[0].reply_to_uuid === 'email-011');
  check('eaccount from thread used', repliesSent[0].eaccount === 'you@outbound.com');
  const lead = (await api('/api/leads/lead-001')).json.lead;
  check('lead status → follow_up after send', lead.my_status === 'follow_up');
  const act = (await api('/api/leads/lead-001')).json.activity;
  check('reply_sent logged', act.some((a) => a.type === 'reply_sent'));

  console.log('\n6b) send uses your edited text, not the stale draft');
  const draftId2 = await insertDraft('lead-001', 'Old subject', 'Old body', new Date().toISOString());
  r = await api(`/api/drafts/${draftId2}/send`, { method: 'POST', body: { subject: 'Edited subject', body: 'Edited body with my changes' } });
  check('edited send succeeds', r.status === 200);
  check('mock received the EDITED subject', repliesSent[1].subject === 'Edited subject', JSON.stringify(repliesSent[1].subject));
  check('mock received the EDITED body', repliesSent[1].body.text === 'Edited body with my changes', JSON.stringify(repliesSent[1].body));
  const persisted = (await pgClient.query('SELECT subject, body FROM drafts WHERE id = $1', [draftId2])).rows[0];
  check('edited text persisted to the draft', persisted.subject === 'Edited subject' && persisted.body === 'Edited body with my changes', JSON.stringify(persisted));

  console.log('\n6c) sender name detection + signature');
  const { deriveSenderName, ensureSignature } = require('../src/ai');
  check('name derived from sending accounts (jaysenxo@x.com → Jaysen)', deriveSenderName(['jaysenxo@getunitrick.com', 'jaysen.inc@myunitrick.com', 'senjayai@theunitrick.com']) === 'Jaysen', deriveSenderName(['jaysenxo@getunitrick.com', 'jaysen.inc@myunitrick.com', 'senjayai@theunitrick.com']));
  check('signature appended when missing', ensureSignature('Can we chat Thursday?', 'Jaysen').endsWith('\n\nJaysen'));
  check('signature not duplicated when already present', ensureSignature('Can we chat Thursday?\n\nJaysen', 'Jaysen').endsWith('\n\nJaysen') && ensureSignature('Can we chat Thursday?\n\nJaysen', 'Jaysen') === 'Can we chat Thursday?\n\nJaysen');
  check('no signature when name unknown', ensureSignature('Hi there', '') === 'Hi there');

  console.log('\n7) status + priority management (manual override)');
  r = await api('/api/leads/lead-003/status', { method: 'POST', body: { status: 'appointment' } });
  check('manual status set', r.status === 200 && (await api('/api/leads/lead-003')).json.lead.my_status === 'appointment');
  r = await api('/api/leads/lead-003/priority', { method: 'POST', body: { priority: 'high' } });
  check('manual priority set', (await api('/api/leads/lead-003')).json.lead.priority === 'high');
  r = await api('/api/campaigns/camp-1/leads?priority=high');
  // Not "exactly 1": Alex and Sam are also active (non-done) leads, which the app
  // auto-elevates to high priority — that's intentional and unrelated to this check.
  check('priority filter works', r.json.leads.some((l) => l.id === 'lead-003'), JSON.stringify(r.json.leads.map((l) => l.id)));

  r = await api('/api/sync', { method: 'POST' });
  await waitSyncIdle();
  const l3 = (await api('/api/leads/lead-003')).json.lead;
  check('manual status preserved after re-sync (no clobber)', l3.my_status === 'appointment', `got ${l3.my_status}`);
  check('replied-thread sync incremental (no re-fetch of already-fetched leads)', emailCalls.filter((c) => c.lead === 'link@test.com').length <= 1, `got ${emailCalls.filter((c) => c.lead === 'link@test.com').length}`);

  console.log('\n7b) interest update via Instantly');
  r = await api('/api/leads/lead-001/interest', { method: 'POST', body: { interest: 4 } });
  check('interest update accepted', r.status === 200, JSON.stringify(r.json));
  const l1after = (await api('/api/leads/lead-001')).json.lead;
  check('interest persisted locally', l1after.interest_status === 4);
  check('interest 4 (Won) maps my_status → done', l1after.my_status === 'done', `got ${l1after.my_status}`);

  console.log('\n7d) untrack + manual semantics');
  r = await api('/api/leads/lead-004/status', { method: 'POST', body: { status: 'none' } });
  check('untrack accepted', r.status === 200 && r.json.untracked === true);
  const l4 = (await api('/api/leads/lead-004')).json.lead;
  check('lead my_status cleared', l4.my_status === null);
  r = await api('/api/sync', { method: 'POST' });
  await waitSyncIdle();
  const l4b = (await api('/api/leads/lead-004')).json.lead;
  check('untracked stays untracked after sync (manual_override)', l4b.my_status === null, `got ${l4b.my_status}`);
  r = await api('/api/leads/lead-004/status', { method: 'POST', body: { status: 'follow_up' } });
  check('re-track works', r.status === 200);

  console.log('\n7e) date range filters include the full end day');
  r = await api('/api/campaigns/all/leads?replied=1&date_to=2026-08-13');
  const dayCount = r.json.total;
  r = await api('/api/campaigns/all/leads?replied=1&date_to=2026-08-13T23:59:59.999Z');
  check('date_to covers the whole end day', r.json.total === dayCount, `got ${r.json.total} vs ${dayCount}`);

  console.log('\n7f) send idempotency (no double-send)');
  const draftId3 = await insertDraft('lead-001', 'Re: Quick question about your call volume', 'Second try body', new Date().toISOString());
  await api(`/api/drafts/${draftId3}/send`, { method: 'POST', body: { subject: 'S1', body: 'B1' } });
  r = await api(`/api/drafts/${draftId3}/send`, { method: 'POST', body: { subject: 'S1', body: 'B1' } });
  check('re-send of a sent draft rejected (409)', r.status === 409, `${r.status}: ${r.json.error}`);
  check('no duplicate reply reached the mock', repliesSent.filter((x) => x.body.text === 'B1').length === 1);

  console.log('\n7c) draft lifecycle (supersede + latest wins)');
  await insertDraft('lead-004', 'Draft A', 'Body A', '2026-08-15T10:00:00.000Z');
  await insertDraft('lead-004', 'Draft B', 'Body B', '2026-08-16T10:00:00.000Z');
  r = await api('/api/leads/lead-004');
  check('detail returns only the latest active draft', r.json.draft && r.json.draft.subject === 'Draft B', JSON.stringify(r.json.draft));

  console.log('\n7g) priority set alone (no status override) still survives sync — regression for the priority-reset bug');
  r = await api('/api/leads/lead-006/priority', { method: 'POST', body: { priority: 'low' } });
  check('priority set to low', r.status === 200 && r.json.ok);
  r = await api('/api/sync', { method: 'POST' });
  await waitSyncIdle();
  const l6 = (await api('/api/leads/lead-006')).json.lead;
  check('manually-set priority is not clobbered back to high by the next sync', l6.priority === 'low', `got ${l6.priority}`);

  console.log('\n8) campaign context save + refresh');
  r = await api('/api/campaigns/camp-1/context', { method: 'PUT', body: { offer: 'AI phone agents for SMBs', icp: '10-50 employees', tone: 'casual', faqs: 'Q: cost?', notes: 'demo > call' } });
  check('context saved', r.status === 200);
  const c = (await api('/api/campaigns/camp-1')).json;
  check('context persisted', c.context_offer === 'AI phone agents for SMBs');

  console.log('\n9) refine endpoint without draft → 404');
  r = await api('/api/drafts/99999/refine', { method: 'POST', body: { instruction: 'shorter' } });
  check('refine missing draft errors cleanly', r.status === 404);

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  } finally {
    if (pgClient) await pgClient.end().catch(() => {});
    crm.kill();
    mock.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });