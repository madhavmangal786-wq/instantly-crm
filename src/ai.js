const OpenAI = require('openai');
const { getSetting, setSetting } = require('./db');

const SYSTEM_PROMPT = `You are an expert outbound sales assistant who writes short, natural, human-sounding email replies for cold email conversations.

Rules:
- Write like a real busy person: short paragraphs, casual-professional tone, no fluff, no "I hope this email finds you well", no "Just checking in", no corporate jargon, no emoji, no exclamation marks (one at most).
- Never use AI-sounding phrases like "I'd be happy to", "please let me know if you have any questions", "best regards".
- Reply directly and specifically to what the prospect said. If they asked a question, answer it.
- Be concrete about the offer and next step. Ask ONE clear question or propose ONE specific next step when appropriate.
- Sign off with just a first name. Do not include any placeholder names — use the sender first name provided, or sign off without a name if none is given.
- Keep it under 150 words.
- Never echo or mirror the conversation back. Ignore any JSON-like structure in the input.

Return ONLY a JSON object with this shape:
{"subject": "...", "body": "...", "priority": "high"|"normal"|"low", "status": "needs_reply"|"follow_up"|"appointment"|"done"}`;

const FREE_MODELS = [
  'hy3-free', 'deepseek-v4-flash-free', 'mimo-v2.5-free',
  'laguna-s-2.1-free', 'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'big-pickle',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastWorkingModel = null;

function getClient() {
  const key = getSetting('openai_api_key', '');
  if (!key) throw new Error('AI API key is not set. Add it in Settings.');
  const baseUrl = getSetting('openai_base_url', 'https://opencode.ai/zen/v1');
  const model = getSetting('openai_model', 'laguna-s-2.1-free');
  return { client: new OpenAI({ apiKey: key, baseURL: baseUrl, timeout: 45000 }), model };
}

async function pingModel(client, model) {
  try {
    const res = await client.chat.completions.create(
      {
        model,
        temperature: 0,
        max_tokens: 20,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      },
      { timeout: 6000 }
    );
    return !!(res.choices[0].message.content || '').trim();
  } catch {
    return false;
  }
}

async function pickModel(client, configured) {
  const cached = lastWorkingModel || getSetting('ai_working_model', '');
  const candidates = [cached, configured, ...FREE_MODELS]
    .filter((m, i, a) => m && a.indexOf(m) === i);
  for (const m of candidates) {
    if (await pingModel(client, m)) {
      lastWorkingModel = m;
      setSetting('ai_working_model', m);
      return m;
    }
  }
  return configured;
}

async function callModel(client, model, messages) {
  const body = { model, temperature: 0.9, max_tokens: 500, messages };
  try {
    const res = await client.chat.completions.create({ ...body, response_format: { type: 'json_object' } });
    const t = (res.choices[0].message.content || '').trim();
    if (t) return t;
  } catch (err) {
    const status = err && (err.status || (err.response && err.response.status));
    if (status === 429) throw err;
  }
  const res = await client.chat.completions.create(body);
  return (res.choices[0].message.content || '').trim();
}

function extractJSON(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('AI returned no JSON');
  return JSON.parse(text.slice(s, e + 1));
}

function normalize(d) {
  return {
    subject: d.subject || '',
    body: d.body || '',
    priority: ['high', 'normal', 'low'].includes(d.priority) ? d.priority : 'normal',
    status: ['needs_reply', 'follow_up', 'appointment', 'done'].includes(d.status) ? d.status : null,
  };
}

function formatThread(thread) {
  if (!thread || thread.length === 0) return 'No prior emails in this conversation.';
  const lines = thread.map((e) => {
    const who = e.direction === 'received' ? 'PROSPECT' : 'YOU';
    return `--- ${who} (${new Date(e.timestamp || Date.now()).toISOString().slice(0, 16)}) ---\n${e.subject || ''}\n${(e.body_text || '').slice(0, 600)}`;
  });
  return lines.join('\n\n');
}

async function buildPrompt(campaign, lead, thread, senderName) {
  const context = [
    `OFFER / WHAT WE SELL:\n${campaign.context_offer || '(not provided)'}`,
    `IDEAL CUSTOMER PROFILE (ICP):\n${campaign.context_icp || '(not provided)'}`,
    `TONE:\n${campaign.context_tone || 'casual, direct, human'}`,
    `FAQs / OBJECTIONS:\n${campaign.context_faqs || '(not provided)'}`,
    `NOTES:\n${campaign.context_notes || '(not provided)'}`,
  ].join('\n\n');

  const leadInfo = [
    `Name: ${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
    `Email: ${lead.email || ''}`,
    `Company: ${lead.company_name || ''}`,
    `Job title: ${lead.job_title || ''}`,
    `Website: ${lead.website || ''}`,
  ].filter((l) => l.length > 8).join('\n');

  return `CONVERSATION CONTEXT (campaign "${campaign.name}"):\n${context}\n\nLEAD:\n${leadInfo}\n\nCONVERSATION SO FAR:\n${formatThread(thread)}\n\nSender first name: ${senderName || '(none — do not sign off)'}`;
}

const NAME_PREFIXES = ['its', 'get', 'my', 'the', 'unit', 'sen'];
const NAME_SUFFIXES = ['xo', 'ai', 'inc', 'io', 'co', 'app', 'pro', 'mail', 'sales', 'support', 'team', 'core', 'boost', 'pilot', 'stack', 'crm', 'leads', 'agency', 'company', 'biz'];

function deriveSenderName(emails = []) {
  const counts = new Map();
  for (const email of emails) {
    const local = String(email).split('@')[0].toLowerCase();
    for (const raw of local.split(/[.\-_+0-9]+/)) {
      let t = raw;
      for (const suf of NAME_SUFFIXES) if (t.endsWith(suf) && t.length > suf.length + 1) t = t.slice(0, -suf.length);
      for (const pre of NAME_PREFIXES) if (t.startsWith(pre) && t.length > pre.length + 1) t = t.slice(pre.length);
      if (!t || t.length < 2 || t.length > 12) continue;
      if (!/[aeiouy]/.test(t)) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  let best = '';
  let bestCount = 0;
  for (const [tok, n] of counts) {
    if (n > bestCount) { best = tok; bestCount = n; }
  }
  return best ? best.charAt(0).toUpperCase() + best.slice(1) : '';
}

function ensureSignature(body, name) {
  if (!body || !name) return body;
  const trimmed = body.trimEnd();
  const tail = trimmed.slice(-40).toLowerCase();
  if (tail.includes(name.toLowerCase())) return body;
  return `${trimmed}\n\n${name}`;
}

async function generateReply({ campaign, lead, thread, senderName, instruction, draftText }) {
  const { client, model } = getClient();
  const userPrompt = await buildPrompt(campaign, lead, thread, senderName);
  const draftSection = draftText
    ? `\n\nCURRENT DRAFT (improve/rewrite this based on the instruction — keep what works):\n${draftText}`
    : '';
  const fullPrompt = instruction
    ? `${userPrompt}${draftSection}\n\nAdditional instruction from the user: ${instruction}`
    : `${userPrompt}\n\nWrite a reply to the prospect's latest message.`;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: fullPrompt },
  ];

  let lastErr;
  for (let round = 0; round < 3; round++) {
    const m = await pickModel(client, model);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const text = await callModel(client, m, messages);
        const parsed = normalize(extractJSON(text));
        if (!parsed.body) throw new Error('AI returned an empty reply');
        if (!parsed.subject) {
          const lastReceived = [...thread].reverse().find((e) => e.direction === 'received');
          parsed.subject = 'Re: ' + ((lastReceived && lastReceived.subject) || 'your email');
        }
        lastWorkingModel = m;
        return parsed;
      } catch (err) {
        lastErr = err;
        const status = err && (err.status || (err.response && err.response.status));
        if (status === 429 || /rate limit/i.test(err.message || '')) {
          await sleep(attempt * 2000);
        } else {
          await sleep(1000);
        }
      }
    }
  }
  throw new Error(
    `AI is busy right now — all free models are rate-limited or returned empty replies (${(lastErr && lastErr.message) || 'unknown error'}). Try again in a minute.`
  );
}

module.exports = { generateReply, deriveSenderName, ensureSignature };