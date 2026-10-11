import { generateMessageID } from "baileys";

import { config } from "./config.js";
import { recentTextMessages } from "./store.js";

// Casa qualquer uma das palavras-chave, só como palavra inteira ("ssentinel" sim,
// "ssentinelx" não), sem diferenciar maiúsculas. O replace escapa caracteres
// especiais de regex e o "|" une as palavras (basta uma aparecer).
const keywordRegex = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${config.aiKeywords
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![\\p{L}\\p{N}_])`,
  "iu",
);

// IDs das últimas mensagens já respondidas (o WhatsApp pode reentregar o mesmo evento).
const handledIds = new Set();
// IDs das respostas que o próprio bot enviou. Servem de anti-loop: se a resposta
// voltar como evento (e tiver a palavra-chave), ela é ignorada. Assim o bot pode
// rodar no seu número sem se responder sozinho.
const botMessageIds = new Set();
// Momentos (ms) das últimas chamadas à IA, para o rate limit.
const callTimestamps = [];

/**
 * Retorna true se a mensagem já foi tratada; senão registra o ID.
 * Mantém no máximo 200 IDs, descartando o mais antigo.
 */
function alreadyHandled(id) {
  if (handledIds.has(id)) {
    return true;
  }

  handledIds.add(id);

  if (handledIds.size > 200) {
    handledIds.delete(handledIds.values().next().value);
  }

  return false;
}

/**
 * Janela deslizante de 60s: retorna true se o limite de chamadas foi atingido.
 * Quando ainda há folga, já registra a chamada atual.
 */
function rateLimited() {
  const now = Date.now();

  // Remove chamadas fora da janela de 1 minuto.
  while (callTimestamps.length && now - callTimestamps[0] > 60_000) {
    callTimestamps.shift();
  }

  if (callTimestamps.length >= config.aiMaxPerMinute) {
    return true;
  }

  callTimestamps.push(now);
  return false;
}

/**
 * Chama a API REST do Gemini. O preprompt vai como instrução de sistema
 * e o texto do grupo como mensagem do usuário. Retorna o texto da resposta.
 */
async function askGemini(preprompt, text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`;

  const body = {
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { maxOutputTokens: config.aiMaxOutputTokens },
  };

  if (preprompt) {
    body.systemInstruction = { parts: [{ text: preprompt }] };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": config.geminiApiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Gemini respondeu ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();

  // A resposta pode vir em várias partes; junta todas em um texto só.
  return (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text || "")
    .join("")
    .trim();
}

/** Formata uma mensagem como "Nome: texto". */
function formatLine(message) {
  const name = message.sender_name || message.sender || "Alguém";

  return `${name}: ${message.text}`;
}

/**
 * Monta o texto enviado ao Gemini: as últimas mensagens do grupo como contexto
 * (se houver) seguidas da mensagem que ativou a palavra-chave.
 */
function buildPrompt(message) {
  const context = recentTextMessages({
    groupJid: message.group_jid,
    limit: config.aiContextMessages,
    excludeId: message.id,
  });

  if (context.length === 0) {
    return message.text;
  }

  return [
    "Mensagens anteriores do grupo (contexto):",
    ...context.map(formatLine),
    "",
    "Mensagem a responder:",
    formatLine(message),
  ].join("\n");
}

/**
 * Se a mensagem do grupo contém a palavra-chave, pergunta ao Gemini e
 * responde no grupo (citando a mensagem original). Nada é guardado.
 */
export async function maybeReply(sock, raw, message) {
  // Sem chave ou sem texto: nada a fazer.
  if (!config.geminiApiKey || !message.text) {
    return;
  }

  if (!keywordRegex.test(message.text) || alreadyHandled(message.id)) {
    return;
  }

  // Mensagem do próprio número só é respondida no modo debug.
  if (message.from_me && !config.aiDebug) {
    return;
  }

  // Resposta enviada pelo próprio bot: ignorada para evitar loop.
  if (botMessageIds.has(message.id)) {
    return;
  }

  if (rateLimited()) {
    console.warn("Limite de chamadas à IA por minuto atingido; mensagem ignorada.");
    return;
  }

  // Montado antes de qualquer await: o buffer ainda não contém esta mensagem
  // (o handler só a guarda depois), então o contexto é só o que veio antes.
  const prompt = buildPrompt(message);

  try {
    const answer = await askGemini(config.preprompt, prompt);

    if (!answer) {
      console.warn("Gemini respondeu sem texto (possível bloqueio de conteúdo); nada enviado.");
      return;
    }

    // O ID é gerado antes do envio para já estar registrado se o evento voltar rápido.
    const messageId = generateMessageID();
    botMessageIds.add(messageId);

    if (botMessageIds.size > 200) {
      botMessageIds.delete(botMessageIds.values().next().value);
    }

    // `quoted` faz o WhatsApp mostrar a resposta como reply da mensagem original.
    await sock.sendMessage(message.group_jid, { text: answer }, { quoted: raw, messageId });
  } catch (error) {
    // Falha da IA não derruba o handler nem manda erro ao grupo.
    console.error("Erro ao responder com a IA:", error.message);
  }
}
