import path from "node:path";
import { readdir, rm } from "node:fs/promises";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
} from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

import { maybeReply } from "./ai.js";
import { config } from "./config.js";
import { addMessage } from "./store.js";

const logger = pino({ level: config.logLevel });

// Estado do módulo: socket atual do Baileys e situação da conexão
// (disconnected | connecting | connected | qr_expired | logged_out).
let socket = null;
let connectionStatus = "disconnected";
let reconnectTimer = null;
let qrAttempts = 0;

export function getConnectionStatus() {
  return connectionStatus;
}

export function getSocket() {
  return socket;
}

/**
 * Agenda uma nova tentativa de conexão em 5s (no máximo uma pendente por vez).
 */
function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp().catch((error) => {
      console.error("Falha ao reconectar:", error);
    });
  }, 5000);
}

/**
 * Apaga os arquivos de sessão, forçando um novo pareamento por QR Code.
 */
async function clearAuthState() {
  const entries = await readdir(config.authDirectory).catch(() => []);

  await Promise.all(
    entries.map((entry) =>
      rm(path.join(config.authDirectory, entry), { recursive: true, force: true }),
    ),
  );
}

/**
 * Extrai um registro simples de uma mensagem do Baileys.
 */
function normalizeMessage(raw) {
  const content = raw.message || {};
  // A primeira chave do objeto indica o tipo (conversation, imageMessage...).
  const type = Object.keys(content)[0] || "unknown";

  // O texto fica em lugares diferentes conforme o tipo; legendas de mídia também contam.
  const text =
    content.conversation
    || content.extendedTextMessage?.text
    || content.imageMessage?.caption
    || content.videoMessage?.caption
    || content.documentMessage?.caption
    || "";

  // Em grupos, `participant` identifica quem enviou.
  const sender = raw.key.participant || raw.key.participantAlt || null;

  return {
    id: raw.key.id,
    group_jid: raw.key.remoteJid,
    sender,
    sender_name: raw.pushName || null,
    from_me: Boolean(raw.key.fromMe),
    type,
    text,
    timestamp: Number(raw.messageTimestamp) || Math.floor(Date.now() / 1000),
  };
}

/**
 * Processa as mensagens recebidas: filtra grupos, aciona a IA e guarda no buffer.
 */
async function handleIncoming({ messages, type }) {
  // "notify" = mensagens novas; "append" = histórico/sincronização.
  if (type !== "notify") {
    return;
  }

  for (const raw of messages) {
    const jid = raw.key?.remoteJid;

    // Só interessam mensagens de grupo (@g.us) com conteúdo.
    if (!raw.message || !jid?.endsWith("@g.us")) {
      continue;
    }

    // Se um grupo foi configurado, ignora os demais.
    if (config.groupJid && jid !== config.groupJid) {
      continue;
    }

    const message = normalizeMessage(raw);

    // Sem await: a chamada à IA não bloqueia o processamento das próximas mensagens.
    maybeReply(socket, raw, message);

    if (addMessage(message)) {
      console.log(
        `[${jid}] ${message.sender_name || message.sender}: ${message.text || `<${message.type}>`}`,
      );
    }
  }
}

/**
 * Abre a conexão com o WhatsApp (ou retoma a sessão salva) e registra os eventos.
 */
export async function connectToWhatsApp() {
  // Evita abrir duas conexões ao mesmo tempo.
  if (connectionStatus === "connecting" || connectionStatus === "connected") {
    return;
  }

  connectionStatus = "connecting";

  // Carrega (ou cria) as credenciais salvas em disco.
  const { state, saveCreds } = await useMultiFileAuthState(config.authDirectory)
    .catch((error) => {
      connectionStatus = "disconnected";
      throw error;
    });

  qrAttempts = 0;

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("SSentinel"),
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  socket = sock;

  // Persiste as credenciais sempre que o WhatsApp as atualiza.
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messages.upsert", handleIncoming);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    // Há um QR Code novo para parear o número.
    if (qr) {
      qrAttempts += 1;

      // Desiste após o limite de tentativas, para não regerar QR para sempre.
      if (qrAttempts > config.maxQrAttempts) {
        console.error(
          `QR Code não escaneado em ${config.maxQrAttempts} tentativa(s). Reinicie o serviço para gerar outro.`,
        );
        connectionStatus = "qr_expired";
        sock.end(new Error("QR Code não escaneado a tempo."));
        return;
      }

      console.log(
        `Escaneie o QR Code (tentativa ${qrAttempts}/${config.maxQrAttempts}):`,
      );
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      connectionStatus = "connected";
      qrAttempts = 0;
      console.log("WhatsApp conectado.");
    }

    if (connection === "close") {
      socket = null;

      // QR expirado: não reconecta sozinho.
      if (connectionStatus === "qr_expired") {
        return;
      }

      connectionStatus = "disconnected";

      const statusCode = lastDisconnect?.error?.output?.statusCode;

      // Deslogado pelo celular: a sessão não vale mais, limpa e espera novo pareamento.
      if (statusCode === DisconnectReason.loggedOut) {
        connectionStatus = "logged_out";
        console.error(
          "Sessão encerrada pelo WhatsApp. Credenciais locais removidas; reinicie para parear de novo.",
        );
        clearAuthState().catch((error) => {
          console.error("Erro ao limpar credenciais:", error);
        });
        return;
      }

      // Qualquer outra queda (rede, reinício do servidor do WhatsApp): reconecta.
      console.warn("Conexão encerrada. Reconectando...");
      scheduleReconnect();
    }
  });
}

/**
 * Desloga no WhatsApp e apaga as credenciais locais.
 */
export async function logoutWhatsApp() {
  // Cancela reconexão pendente, senão ela reabriria a sessão.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (socket) {
    await socket.logout().catch((error) => {
      console.error("Erro ao deslogar (credenciais locais serão limpas):", error);
    });
  }

  socket = null;
  connectionStatus = "logged_out";
  await clearAuthState();
}
