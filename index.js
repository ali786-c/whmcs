const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");
const NodeCache = require("node-cache");
const pino = require("pino");
const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const axios = require("axios");
const path = require("path");
const fs = require("fs");

// Process Management - Prevent double execution on cPanel
const lockFile = path.join(__dirname, "bridge.lock");
const PID = process.pid;

if (fs.existsSync(lockFile)) {
    const oldPid = fs.readFileSync(lockFile, "utf8");
    console.log(`Found old lock file (PID ${oldPid}). Current PID is ${PID}. Overwriting...`);
}
fs.writeFileSync(lockFile, PID.toString());

// Cleanup lock on exit
process.on("exit", () => {
    try { if (fs.readFileSync(lockFile, "utf8") === PID.toString()) fs.unlinkSync(lockFile); } catch (e) { }
});

const msgRetryCounterCache = new NodeCache();

if (!global.crypto) {
    try { global.crypto = require('crypto').webcrypto; } catch (e) { }
}

const app = express();
app.set('trust proxy', 1);
app.use(cors({
    origin: '*',
    allowedHeaders: ['Content-Type', 'Authorization', 'bypass-tunnel-reminder', 'ngrok-skip-browser-warning']
}));
app.use(express.json());

const port = process.env.PORT || 3000;
let sock = null;
let qrCode = null;
let pairingCode = null;
let isConnected = false;
let bridgeStatus = "Starting...";
let fullErrorInfo = null;
const startupTime = new Date().toISOString();
let apiKey = process.env.API_KEY || "your_secret_key"; // Basic auth key

let whmcsUrl = process.env.WHMCS_URL || ""; // Root URL
let adminUrl = ""; // Full Admin Addon URL
let aiSettings = { key: "", model: "", prompt: "" };

async function fetchAiSettings() {
    if (!adminUrl) return;
    try {
        const sep = adminUrl.includes("?") ? "&" : "?";
        const res = await axios.get(`${adminUrl}${sep}action=get_config&key=${apiKey}`);
        if (res.data && res.data.openrouter_key) {
            aiSettings = {
                key: res.data.openrouter_key,
                model: res.data.ai_model,
                prompt: res.data.ai_prompt
            };
            console.log("✅ AI Settings Loaded from WHMCS");
        }
    } catch (e) {
        console.log("❌ Failed to fetch AI Settings:", e.message);
    }
}

async function logToWhmcs(phone, message, direction = "in") {
    if (!adminUrl) {
        console.log("⚠️ Admin URL not linked. Open WHMCS Dashboard.");
        return;
    }
    try {
        const sep = adminUrl.includes("?") ? "&" : "?";
        const url = `${adminUrl}${sep}action=log_msg&key=${apiKey}&phone=${phone}&message=${encodeURIComponent(message)}&direction=${direction}`;
        const res = await axios.get(url);
        if (res.data && res.data.status === "success") {
            console.log(`✅ Logged ${direction} message to WHMCS`);
        } else {
            console.log(`❌ WHMCS Log Error: Invalid Response`);
            console.log(`Raw Response:`, typeof res.data === 'string' ? res.data.substring(0, 200) : res.data);
        }
    } catch (e) {
        console.log(`❌ Failed to log to WHMCS: ${e.message}`);
    }
}

async function getAiReply(userMessage) {
    if (!aiSettings.key) return null;
    try {
        const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            model: aiSettings.model || "google/gemini-2.0-flash-exp:free",
            messages: [
                { role: "system", content: aiSettings.prompt || "You are a helpful assistant." },
                { role: "user", content: userMessage }
            ]
        }, {
            headers: {
                "Authorization": `Bearer ${aiSettings.key}`,
                "Content-Type": "application/json"
            }
        });
        return response.data.choices[0].message.content;
    } catch (e) {
        console.error("🤖 OpenRouter Error:", e.response?.data || e.message);
        return null;
    }
}

const authPath = path.join(__dirname, "auth_info");

function ensureAuthFolder() {
    if (!fs.existsSync(authPath)) {
        try { fs.mkdirSync(authPath, { recursive: true }); } catch (e) { }
    }
}

function clearAuthFolder() {
    console.log("Cleaning session files...");
    try {
        if (fs.existsSync(authPath)) {
            const files = fs.readdirSync(authPath);
            for (const file of files) {
                try { fs.unlinkSync(path.join(authPath, file)); } catch (e) { }
            }
        }
    } catch (e) {
        try { fs.rmSync(authPath, { recursive: true, force: true }); } catch (e2) { }
    }
    ensureAuthFolder();
}

ensureAuthFolder();

async function connectToWhatsApp() {
    try {
        bridgeStatus = "Initializing Baileys...";
        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        let version = [2, 3000, 1015901307];
        try {
            const latest = await fetchLatestBaileysVersion();
            version = latest.version;
        } catch (e) { }

        sock = makeWASocket({
            version,
            logger: pino({ level: "info" }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "info" })),
            },
            printQRInTerminal: false,
            // Optimized macOS identity - often more stable than Ubuntu/Chrome generic
            browser: ["macOS", "Safari", "17.0"],
            msgRetryCounterCache,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            fireInitQueries: true,
            generateHighQualityLinkPreview: false
        });

        bridgeStatus = "Socket created, waiting for QR/Connection...";

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCode = await QRCode.toDataURL(qr);
                bridgeStatus = "QR Code Generated - SCAN or Use Pairing Code!";
            }

            if (connection === "close") {
                isConnected = false;
                const err = lastDisconnect?.error;
                const statusCode = err?.output?.statusCode;
                const reason = err?.message || "";

                fullErrorInfo = { message: reason, code: statusCode };

                console.log(`Connection Close: Code ${statusCode}, Reason: ${reason}`);

                if (statusCode === 401 || reason.includes("conflict") || reason.includes("device_removed")) {
                    bridgeStatus = "Auth Session Error. Resetting in 10s...";
                    clearAuthFolder();
                    setTimeout(connectToWhatsApp, 10000);
                } else {
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    bridgeStatus = `Disconnected (${statusCode}). Reconnecting...`;
                    if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
                }
            } else if (connection === "open") {
                // ADD DELAY: Allow internal sync to finish before marking as green
                bridgeStatus = "Synchronizing session... Please wait 5 seconds.";
                await new Promise(r => setTimeout(r, 5000));

                isConnected = true;
                qrCode = null;
                pairingCode = null;
                fullErrorInfo = null;
                bridgeStatus = "Connected!";
                console.log(`WhatsApp Opened Successfully (PID ${PID})`);
                fetchAiSettings();
            }
        });

        // Handle Incoming Messages & AI Auto-Reply
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") return;
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const sender = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (!text) return;

            // Extract actual phone number (PN) instead of LID if possible
            let phone = sender.split("@")[0];

            // If it's a LID (@lid), try to find the actual phone number (senderPn)
            if (sender.includes("@lid")) {
                const pn = msg.key.senderPn || msg.key.participant || msg.participant;
                if (pn && pn.includes("@s.whatsapp.net")) {
                    phone = pn.split("@")[0];
                }
            }

            console.log(`📩 New message from ${phone}: ${text}`);

            // 1. Log to WHMCS
            logToWhmcs(phone, text, "in");

            // 2. Handle AI Auto-Reply
            if (aiSettings.key) {
                console.log(`🤖 AI is thinking for ${phone}...`);
                const reply = await getAiReply(text);
                if (reply) {
                    await sock.sendMessage(sender, { text: reply });
                    console.log(`📤 AI replied to ${phone}`);
                    // Log the reply as well
                    logToWhmcs(phone, reply, "out");
                }
            }
        });

        sock.ev.on("creds.update", saveCreds);

    } catch (err) {
        fullErrorInfo = { message: err.message };
        bridgeStatus = "Init Error: " + err.message;
        setTimeout(connectToWhatsApp, 10000);
    }
}

app.get("*", async (req, res) => {
    try {
        const action = req.query.action || "home";

        if (action === "status") {
            // Priority 1: Sync API Key from Dashboard if mismatch
            if (req.query.key && req.query.key !== apiKey) {
                apiKey = req.query.key; // Update key to match WHMCS
                console.log(`🔑 API Key updated to match WHMCS`);
            }

            // Priority 2: Explicitly passed URL
            if (req.query.admin_url && adminUrl !== req.query.admin_url) {
                adminUrl = req.query.admin_url;
                console.log(`📍 Linked with WHMCS Admin: ${adminUrl}`);
                fetchAiSettings();
            }

            // Fallback: Auto-detect (Optional)
            if (!adminUrl && req.headers.referer) {
                const ref = req.headers.referer;
                if (ref.includes("addonmodules.php")) {
                    adminUrl = ref.split("&")[0]; // Capture base addon URL
                    console.log(`📍 Auto-detected Admin: ${adminUrl}`);
                    fetchAiSettings();
                }
            }

            return res.json({
                connected: isConnected,
                qr: qrCode,
                pairing_code: pairingCode,
                number: (sock && sock.user && sock.user.id) ? sock.user.id.split(":")[0] : null,
                message: bridgeStatus,
                pid: PID,
                uptime: startupTime,
                debug: fullErrorInfo
            });
        }

        if (action === "get_pairing_code") {
            const phone = req.query.phone;
            if (!phone) return res.status(400).json({ error: "Phone required" });
            const code = await sock.requestPairingCode(phone.replace(/\D/g, ""));
            pairingCode = code;
            return res.json({ status: "success", code: code });
        }

        if (action === "send" || action === "test_msg") {
            let target = req.query.to;
            if (!target && action === "test_msg") target = sock?.user?.id?.split(":")[0];

            if (!isConnected) return res.status(500).json({ error: "Bridge not connected" });
            if (!target) return res.status(400).json({ error: "No target number" });

            // Clean number and add JID suffix
            const cleanTarget = target.replace(/\D/g, "");
            const jid = `${cleanTarget}@s.whatsapp.net`;

            console.log(`🚀 Sending message to: ${jid}`);

            const result = await sock.sendMessage(jid, { text: req.query.message || "WHMCS Bridge Test Message" });
            console.log(`✔ Sent successfully! ID: ${result.key.id}`);

            // Log outgoing message to WHMCS
            logToWhmcs(cleanTarget, req.query.message || "WHMCS Bridge Test Message", "out");

            return res.json({ status: "success", target: jid, messageId: result.key.id });
        }

        if (action === "force_reset") {
            isConnected = false;
            clearAuthFolder();
            if (sock) { try { sock.logout(); } catch (e) { } }
            return res.json({ status: "reset" });
        }

        res.send(`Bridge running (PID ${PID}). Status: ${bridgeStatus}`);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => {
    console.log(`Bridge Started on PID: ${PID}`);
    connectToWhatsApp();
});
