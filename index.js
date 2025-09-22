// server.js
const express = require("express");
const { MongoClient } = require("mongodb");
const { Boom } = require("@hapi/boom");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MONGO_URI = "mongodb://localhost:27017";
const client = new MongoClient(MONGO_URI);

let sock = null;
let qrState = null;
let isClearingSession = false;

// Pasta onde o Baileys salva arquivos locais
const SESSION_FOLDER = path.join(__dirname, "auth_info_baileys");

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

/**
 * Função principal de conexão com o WhatsApp
 */
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  // Atualiza QR para interface
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrState = qr;
      io.emit("qr", `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=250x250`);
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      io.emit("log", "Conexão fechada");
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === "open") {
      io.emit("user", "Conectado");
      io.emit("log", "Bot conectado ao WhatsApp");
    }
  });

  sock.ev.on("creds.update", async (creds) => {
    if (!isClearingSession) {
      await saveCreds();
    }
  });
}

/**
 * Socket.IO - envia estado inicial ao novo cliente
 */
io.on("connection", (socket) => {
  socket.emit("init", {
    isConnected: !!sock,
    userName: sock?.user?.name || null,
  });
  if (qrState) {
    socket.emit(
      "qr",
      `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qrState)}&size=250x250`
    );
  }
});

/**
 * Rota: Conectar bot
 */
app.post("/connect-bot", async (req, res) => {
  try {
    if (!sock) {
      await connectToWhatsApp();
    }
    res.json({ message: "Reconexão solicitada" });
  } catch (err) {
    console.error("Erro ao conectar bot:", err);
    res.status(500).json({ message: "Erro ao conectar bot" });
  }
});

/**
 * Rota: Desconectar bot
 */
app.post("/disconnect-bot", async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      sock = null;
    }
    qrState = null;
    res.json({ message: "Bot desconectado" });
  } catch (err) {
    console.error("Erro ao desconectar:", err);
    res.status(500).json({ message: "Erro ao desconectar bot" });
  }
});

/**
 * Rota: Limpar sessão (sem deslogar o bot ativo)
 */
app.post("/clear-session", async (req, res) => {
  if (isClearingSession) {
    return res.status(409).json({ success: false, message: "Limpeza já em andamento" });
  }
  isClearingSession = true;

  try {
    // Apaga sessão do MongoDB
    await client.connect();
    await client.db("baileys").collection("sessions").deleteMany({});

    // Apaga arquivos locais
    if (fs.existsSync(SESSION_FOLDER)) {
      fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
    }

    qrState = null;
    res.json({ success: true, message: "Sessão apagada. Bot continua conectado." });
  } catch (err) {
    console.error("Erro ao limpar sessão:", err);
    res.status(500).json({ success: false, message: "Erro ao limpar sessão" });
  } finally {
    isClearingSession = false;
  }
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  connectToWhatsApp(); // inicia o bot automaticamente
});
