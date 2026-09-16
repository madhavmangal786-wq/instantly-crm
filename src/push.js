const webpush = require('web-push');
const { query, getSetting, setSetting } = require('./db');

let vapidReady = false;

async function ensureVapidKeys() {
  let pub = await getSetting('vapid_public_key', '');
  let priv = await getSetting('vapid_private_key', '');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    await setSetting('vapid_public_key', pub);
    await setSetting('vapid_private_key', priv);
  }
  if (!vapidReady) {
    webpush.setVapidDetails('mailto:admin@localhost', pub, priv);
    vapidReady = true;
  }
  return { publicKey: pub };
}

async function saveSubscription(sub) {
  if (!sub || !sub.endpoint || !sub.keys) throw new Error('Invalid subscription');
  await query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString()]
  );
}

async function removeSubscription(endpoint) {
  if (!endpoint) return;
  await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

async function sendToAll(title, body, url) {
  await ensureVapidKeys();
  const subs = (await query('SELECT * FROM push_subscriptions')).rows;
  const payload = JSON.stringify({ title, body, url: url || '/' });
  let sent = 0;
  for (const s of subs) {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(s.endpoint); // subscription expired or was revoked
      } else {
        console.error('[push] send failed:', err.message);
      }
    }
  }
  return { sent, total: subs.length };
}

// leads: array of lead rows (from the `leads` table) who got a genuinely new reply this sync.
async function notifyNewReplies(leads) {
  const withData = (leads || []).filter(Boolean);
  if (withData.length === 0) return;
  const name = (l) => l.first_name || l.email || 'A lead';
  let title, body;
  if (withData.length === 1) {
    const l = withData[0];
    title = 'New reply';
    body = `${name(l)}${l.company_name ? ' — ' + l.company_name : ''} replied`;
  } else {
    title = `${withData.length} new replies`;
    body = withData.slice(0, 3).map(name).join(', ') + (withData.length > 3 ? ', …' : '');
  }
  await sendToAll(title, body, '/');
}

module.exports = { ensureVapidKeys, saveSubscription, removeSubscription, notifyNewReplies, sendToAll };
