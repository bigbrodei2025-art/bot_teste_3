// --- Imports e Configurações Iniciais ---
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  useMultiFileAuthState
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const P = require("pino");
const fs = require("fs");
const path = require("path");
const express = require("express");
const compression = require("compression");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const qrcode = require("qrcode");
const crypto = require("crypto");
require("dotenv").config();

// --- Variáveis ---
const { MONITORED_GROUP_JID, TARGET_GROUP_JID } = require("./config");

const SHOPEE_APP_ID = process.env.SHOPEE_APP_ID;
const SHOPEE_SECRET = process.env.SHOPEE_SECRET;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SHOPEE_API_URL = "https://open-api.affiliate.shopee.com.br/graphql";
const GOOGLE_API_URL = "https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent";
const PROMPT_IA = `Atue como um especialista em vendas no varejo — criativo, persuasivo e empolgado! Escreva um parágrafo curto (máximo 2 linhas), com emojis, para vender o seguinte produto: {nome_produto}.`;

// --- Funções Auxiliares ---
async function gerarAssinaturaShopee(timestamp, payload) {
  const str = `${SHOPEE_APP_ID}${timestamp}${payload}${SHOPEE_SECRET}`;
  return crypto.createHash("sha256").update(str).digest("hex");
}

async function fazerRequisicaoShopee(query) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ query });
  const assinatura = await gerarAssinaturaShopee(timestamp, payload);
  const headers = {
    Authorization: `SHA256 Credential=${SHOPEE_APP_ID}, Timestamp=${timestamp}, Signature=${assinatura}`,
    "Content-Type": "application/json"
  };
  try {
    const resposta = await axios.post(SHOPEE_API_URL, payload, { headers, timeout: 30000 });
    return resposta.data;
  } catch (error) {
    console.error("❌ Erro na requisição Shopee:", error.message);
    return { errors: [{ message: "Erro na requisição Shopee" }] };
  }
}

function normalizarPreco(valor) {
  try {
    const v = parseFloat(valor);
    return v >= 1000 ? v / 100 : v;
  } catch {
    return 0.0;
  }
}

async function obterProdutoPorId(itemId, shopId) {
  const query = `{
    productOfferV2(itemId: "${itemId}", shopId: "${shopId}") {
      nodes { itemId productName priceMin offerLink imageUrl priceDiscountRate }
    }
  }`;
  const resultado = await fazerRequisicaoShopee(query);
  if (resultado.errors) return null;
  const nodes = resultado.data?.productOfferV2?.nodes;
  if (!nodes || !nodes.length) return null;

  const produto = nodes[0];
  const precoPromocional = normalizarPreco(produto.priceMin);
  const desconto = produto.priceDiscountRate || 0;
  let precoOriginal = precoPromocional;
  if (desconto > 0) precoOriginal = precoPromocional / (1 - desconto / 100);
  precoOriginal = Math.max(precoOriginal, precoPromocional);

  return { ...produto, precoMin: precoPromocional, precoOriginal };
}

async function gerarMensagemPromocional(nomeProduto) {
  const prompt = PROMPT_IA.replace("{nome_produto}", nomeProduto);
  try {
    const url = `${GOOGLE_API_URL}?key=${GOOGLE_API_KEY}`;
    const dados = { contents: [{ parts: [{ text: prompt }] }] };
    const resposta = await axios.post(url, dados, { timeout: 15000 });
    const mensagem = resposta.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return mensagem || "Essa oferta está imperdível! 🎉";
  } catch {
    return "Essa oferta está imperdível! 🎉";
  }
}

async function parseUrl(url) {
  if (url.includes("s.shopee.com.br") || url.includes("shope.ee")) {
    try {
      const response = await axios.head(url, { maxRedirects: 10, timeout: 5000 });
      url = response.request.res.responseUrl;
    } catch {}
  }
  const patterns = [/product\/(\d+)\/(\d+)/, /itemId=(\d+).*shopId=(\d+)/, /i\.(\d+)\.(\d+)/];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return { itemId: m[2] || m[1], shopId: m[1] };
  }
  return { itemId: null, shopId: null };
}

// --- Servidor Express ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 1000;
const client = new MongoClient(process.env.MONGO_URL);

let sock, socketCliente, qrState = null, reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

async function saveSessionToMongo(sessionPath) {
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
    for (const d of docs) fs.writeFileSync(path.join(sessionPath, d.fileName), d.content);
    return true;
  } catch (e) {
    console.error("Erro ao restaurar sessão:", e);
    return false;
  }
}

async function connectToWhatsApp() {
  const sessionPath = path.join(__dirname, "auth_info_baileys");
  await restoreSessionFromMongo(sessionPath);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, logger: P({ level: "silent" }), auth: state });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await saveSessionToMongo(sessionPath);
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) { reconnectAttempts = 0; qrState = qr; if (socketCliente) updateQR("qr"); }
    if (connection === "close") {
      reconnectAttempts++;
      const reason = lastDisconnect?.error?.output?.statusCode;
      if ([DisconnectReason.badSession, DisconnectReason.loggedOut].includes(reason) || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        await client.db("baileys").collection("sessions").deleteMany({});
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        reconnectAttempts = 0; qrState = null;
        connectToWhatsApp();
      } else setTimeout(connectToWhatsApp, Math.min(10000, reconnectAttempts * 2000));
    } else if (connection === "open") {
      reconnectAttempts = 0; qrState = null;
      if (socketCliente) updateQR("connected");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    const msg = m?.message?.conversation || m?.message?.extendedTextMessage?.text || "";
    if (!m.message || m.key.fromMe) return;

    const sender = m.key.remoteJid;
    if (sender === MONITORED_GROUP_JID) {
      // Extrair URLs
      const urls = (msg.match(/\bhttps?:\/\/\S+/gi) || []);
      const shopeeUrls = urls.filter(u => u.includes("shopee") || u.includes("shope.ee") || u.includes("s.shopee.com.br"));
      if (shopeeUrls.length === 0) return; // Ignora mensagens sem Shopee

      const shopeeUrl = shopeeUrls[0];
      const info = await parseUrl(shopeeUrl);
      if (info.itemId && info.shopId) {
        const produto = await obterProdutoPorId(info.itemId, info.shopId);
        if (produto) {
          const promo = await gerarMensagemPromocional(produto.productName);
          const texto = `🔥 *${produto.productName}*\n*De* ~~R$ ${produto.precoOriginal.toFixed(2)}~~\n💰 *Por R$ ${produto.precoMin.toFixed(2)}* 😱\n(${produto.priceDiscountRate || 0}% OFF)\n\n${promo}\n\n🛒 *Compre agora* 👉 ${produto.offerLink}\n\n⚠️ _Promoção sujeita a alterações._`;
          if (produto.imageUrl) {
            await sock.sendMessage(TARGET_GROUP_JID, { image: { url: produto.imageUrl }, caption: texto });
          } else {
            await sock.sendMessage(TARGET_GROUP_JID, { text: texto });
          }
        }
      }
    }
  });
}

function updateQR(status) {
  if (!socketCliente) return;
  if (status === "qr" && qrState) {
    qrcode.toDataURL(qrState, (err, url) => { if (!err) socketCliente.emit("qr", url); });
  } else if (status === "connected") {
    socketCliente.emit("qrstatus", "./assets/check.svg");
  } else if (status === "loading") {
    socketCliente.emit("qrstatus", "./assets/loader.gif");
  }
}

io.on("connection", socket => { socketCliente = socket; if (sock?.user) updateQR("connected"); else if (qrState) updateQR("qr"); else updateQR("loading"); });

process.on("SIGINT", async () => { await client.close(); process.exit(0); });

connectToWhatsApp().catch(console.error);
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
