import { timingSafeEqual } from "node:crypto";

import express from "express";

import { config, validateConfig } from "./config.js";
import { listMessages } from "./store.js";
import {
  connectToWhatsApp,
  getConnectionStatus,
  getSocket,
  logoutWhatsApp,
} from "./whatsapp.js";

// Aborta a inicialização se a configuração obrigatória estiver inválida.
validateConfig();

const app = express();
// Limite da imagem já decodificada (o base64 no JSON ocupa ~33% a mais, daí o limite de 15mb abaixo).
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

app.use(express.json({ limit: "15mb" }));

/**
 * Aceita "Authorization: Bearer <token>" ou "x-api-key: <token>".
 * Comparação em tempo constante.
 */
function authenticate(request, response, next) {
  const bearer = request.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const received = bearer || request.get("x-api-key") || "";

  const expectedBuffer = Buffer.from(config.apiToken);
  const receivedBuffer = Buffer.from(received);

  // timingSafeEqual exige buffers do mesmo tamanho, por isso a checagem de length antes.
  const valid =
    expectedBuffer.length === receivedBuffer.length
    && timingSafeEqual(expectedBuffer, receivedBuffer);

  if (!valid) {
    return response.status(401).json({ error: "Token inválido ou ausente." });
  }

  return next();
}

/** Bloqueia a rota (503) enquanto o WhatsApp não estiver conectado. */
function requireConnected(request, response, next) {
  if (getConnectionStatus() !== "connected") {
    return response.status(503).json({ error: "O WhatsApp não está conectado." });
  }

  return next();
}

/** Bloqueia a rota (503) se o grupo monitorado não foi configurado. */
function requireGroup(request, response, next) {
  if (!config.groupJid) {
    return response.status(503).json({
      error: "WHATSAPP_GROUP_JID não configurado. Use GET /groups para descobrir o JID.",
    });
  }

  return next();
}

/** Público: só informa que o serviço está de pé. */
app.get("/health", (request, response) => {
  response.json({
    status: "ok",
    service: "ssentinel",
    whatsapp: getConnectionStatus(),
  });
});

/** Lista os grupos da conta para descobrir o JID. */
app.get("/groups", authenticate, requireConnected, async (request, response) => {
  try {
    const groups = await getSocket().groupFetchAllParticipating();

    // Transforma o objeto {jid: metadados} em lista ordenada por nome.
    const list = Object.entries(groups)
      .map(([jid, metadata]) => ({
        name: metadata?.subject || "Grupo sem nome",
        jid,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

    response.json({ groups: list });
  } catch (error) {
    console.error("Erro ao listar grupos:", error);
    response.status(502).json({ error: "Não foi possível listar os grupos." });
  }
});

/**
 * Mensagens recebidas do grupo configurado.
 * Query: since (timestamp em segundos), limit (1-500, padrão 100).
 */
app.get("/messages", authenticate, requireGroup, (request, response) => {
  const since = Number(request.query.since) || 0;
  // Força o limite para o intervalo 1-500.
  const limit = Math.min(Math.max(Number(request.query.limit) || 100, 1), 500);

  const messages = listMessages({ since, limit });

  response.json({ group_jid: config.groupJid, count: messages.length, messages });
});

/** Envia texto ao grupo configurado. Body: { "text": "..." } */
app.post(
  "/messages/text",
  authenticate,
  requireGroup,
  requireConnected,
  async (request, response) => {
    const { text } = request.body ?? {};

    if (typeof text !== "string" || text.length === 0) {
      return response.status(400).json({ error: "O campo 'text' é obrigatório." });
    }

    try {
      const result = await getSocket().sendMessage(config.groupJid, { text });

      return response.json({ status: "sent", message_id: result?.key?.id || null });
    } catch (error) {
      console.error("Erro ao enviar texto:", error);
      return response.status(502).json({ error: "Não foi possível enviar a mensagem." });
    }
  },
);

/** Envia imagem ao grupo. Body: { "image_base64": "...", "caption": "..." } */
app.post(
  "/messages/image",
  authenticate,
  requireGroup,
  requireConnected,
  async (request, response) => {
    const { image_base64: imageBase64, caption = "" } = request.body ?? {};

    if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
      return response.status(400).json({ error: "O campo 'image_base64' é obrigatório." });
    }

    // Decodifica o base64 para bytes; base64 inválido resulta em buffer vazio.
    const image = Buffer.from(imageBase64, "base64");

    if (image.length === 0) {
      return response.status(400).json({ error: "A imagem recebida está vazia." });
    }

    if (image.length > MAX_IMAGE_BYTES) {
      return response.status(413).json({ error: "A imagem ultrapassa o limite de 10 MB." });
    }

    try {
      const result = await getSocket().sendMessage(config.groupJid, { image, caption });

      return response.json({ status: "sent", message_id: result?.key?.id || null });
    } catch (error) {
      console.error("Erro ao enviar imagem:", error);
      return response.status(502).json({ error: "Não foi possível enviar a imagem." });
    }
  },
);

/** Desloga e apaga a sessão, para parear outro número. */
app.post("/session/logout", authenticate, async (request, response) => {
  try {
    await logoutWhatsApp();
    response.json({ status: "logged_out" });
  } catch (error) {
    console.error("Erro ao deslogar:", error);
    response.status(500).json({ error: "Não foi possível deslogar." });
  }
});

// Inicia a conexão com o WhatsApp em paralelo; a API sobe mesmo se ela falhar.
connectToWhatsApp().catch((error) => {
  console.error("Erro ao iniciar a conexão com o WhatsApp:", error);
});

// 0.0.0.0 para aceitar conexões de fora do container (o compose restringe a 127.0.0.1).
app.listen(config.port, "0.0.0.0", () => {
  console.log(`SSentinel ouvindo na porta ${config.port}.`);
});
