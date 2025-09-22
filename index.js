// --- Imports e Configurações ---
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  useMultiFileAuthState
} = require("@whiskeysockets/baileys");
const express = require("express");
const { Server } = require("socket.io");
const http = require("http");
const compression = require("compression");
const path = require("path");
const fs = require("fs");
const { MongoClient } = require("mongodb");
const qrcode = require("qrcode");
const P = require("pino");
require("dotenv").config();

const MONGO_URL = process.env.MONGO_URL;
const PORT = process.env.PORT || 3000;
const client = new MongoClient(MONGO_URL);

let sock, socketCliente, qrState = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let isClearingSession = false; // FLAG para evitar conflitos

// --- Express / Socket.IO ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Salvar e Restaurar Sessão ---
async function saveSessionToMongo(sessionPath) {
  if (isClearingSession) return; // Não salvar enquanto limpa
  try {
    await client.connect();
    const col = client.db("baileys").collection("sessions");
    for (const f of fs.readdirSync(sessionPath)) {
      const content = fs.readFileSync(path.join(sessionPath, f), "utf8");
      await col.updateOne({ fileName: f }, { $set: { content } }, { upsert: true });
    }
  } catch (e) {
    console.error("Erro ao salvar sessão:", e);
  }
}

async function restoreSessionFromMongo(sessionPath) {
  try {
    await client.connect();
    const docs = await client.db("baileys").collection("sessions").find({}).toArray();
    if (!docs.length) return false;
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
    for (const d of docs) {
      fs.writeFileSync(path.join(sessionPath, d.fileName), d.content);
    }
    return true;
  } catch (e) {
    console.error("Erro ao restaurar sessão:", e);
    return false;
  }
}

// --- Atualizar QR para front ---
function updateQR(status) {
  if (!socketCliente) return;
  if (status === "qr" && qrState) {
    qrcode.toDataURL(qrState, (err, url) => {
      if (!err) socketCliente.emit("qr", url);
    });
  } else if (status === "connected") {
    socketCliente.emit("qrstatus", "./assets/check.svg");
  } else if (status === "loading") {
    socketCliente.emit("qrstatus", "./assets/loader.gif");
  }
}

// --- Conexão ao WhatsApp ---
async function connectToWhatsApp() {
  const sessionPath = path.join(__dirname, "auth_info_baileys");
  await restoreSessionFromMongo(sessionPath);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    auth: state
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await saveSessionToMongo(sessionPath);
  });

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      reconnectAttempts = 0;
      qrState = qr;
      updateQR("qr");
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect =
        ![DisconnectReason.loggedOut, DisconnectReason.badSession].includes(reason) &&
        reconnectAttempts < MAX_RECONNECT_ATTEMPTS;

      if (shouldReconnect) {
        reconnectAttempts++;
        setTimeout(connectToWhatsApp, Math.min(10000, reconnectAttempts * 2000));
      } else {
        reconnectAttempts = 0;
        qrState = null;
        console.log("Sessão encerrada. Aguarde nova conexão.");
      }
    } else if (connection === "open") {
      reconnectAttempts = 0;
      qrState = null;
      updateQR("connected");
      console.log("Bot conectado ao WhatsApp");
    }
  });
}

// --- Rotas ---
app.post("/connect-bot", async (req, res) => {
  if (sock?.user) {
    return res.json({ message: "Bot já conectado" });
  }
  connectToWhatsApp();
  res.json({ message: "Iniciando conexão..." });
});

app.post("/disconnect-bot", async (req, res) => {
  if (!sock) return res.json({ message: "Bot não está conectado" });
  try {
    await sock.logout(); // Desloga explicitamente
    res.json({ message: "Desconectado com sucesso" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Erro ao desconectar" });
  }
});

app.post("/clear-session", async (req, res) => {
  if (isClearingSession) {
    return res.status(409).json({ success: false, message: "Limpeza já em andamento" });
  }
  isClearingSession = true;

  try {
    await client.connect();
    await client.db("baileys").collection("sessions").deleteMany({});

    const sessionPath = path.join(__dirname, "auth_info_baileys");
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    qrState = null;
    res.json({ success: true, message: "Sessão limpa. Bot permanece conectado." });
  } catch (err) {
    console.error("Erro ao limpar sessão:", err);
    res.status(500).json({ success: false, message: "Erro ao limpar sessão" });
  } finally {
    isClearingSession = false;
  }
});

// --- Socket.IO ---
io.on("connection", socket => {
  socketCliente = socket;
  if (sock?.user) updateQR("connected");
  else if (qrState) updateQR("qr");
  else updateQR("loading");
});

process.on("SIGINT", async () => {
  await client.close();
  process.exit(0);
});

connectToWhatsApp().catch(console.error);
server.listen(PORT, () => console.log(`Server rodando na porta ${PORT}`));
