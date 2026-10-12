import { generateMessageID } from "baileys";

import { config } from "./config.js";
import { recentTextMessages } from "./store.js";

// Casa qualquer uma das palavras-chave, só como palavra inteira ("ssentinel" sim,
// "ssentinelx" não), sem diferenciar maiúsculas. O replace escapa caracteres
// especiais de regex e o "|" une as palavras (basta uma aparecer).
const keywordPattern = `(?<![\\p{L}\\p{N}_])(?:${config.aiKeywords
  .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|")})(?![\\p{L}\\p{N}_])`;
const keywordRegex = new RegExp(keywordPattern, "iu");
// Versão global, usada para remover as palavras-chave do texto.
const keywordStripRegex = new RegExp(keywordPattern, "giu");

// Marcador que o preprompt manda o modelo responder quando a mensagem não tem contexto.
const IGNORE_MARKER = "[IGNORE]";

/**
 * Conta as palavras que sobram na mensagem depois de tirar as palavras-chave.
 * Pontuação e emojis não contam.
 */
function meaningfulWordCount(text) {
  return (text.replace(keywordStripRegex, " ").match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

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
 * Chama a API REST da IA. O preprompt vai como instrução de sistema
 * e o texto do grupo como mensagem do usuário. Retorna o texto da resposta.
 */
async function askAI(preprompt, text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.aiModel}:generateContent`;

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
      "x-goog-api-key": config.aiApiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`IA respondeu ${response.status}: ${await response.text()}`);
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
 * Monta o texto enviado à IA: as últimas mensagens do grupo como contexto
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
 * Se a mensagem do grupo contém a palavra-chave, pergunta à IA e
 * responde no grupo (citando a mensagem original). Nada é guardado.
 */
export async function maybeReply(sock, raw, message) {
  // Sem chave ou sem texto: nada a fazer.
  if (!config.aiApiKey || !message.text) {
    return;
  }

  // A palavra-chave vale tanto no texto quanto no nome de quem enviou.
  const matches = keywordRegex.test(message.text)
    || keywordRegex.test(message.sender_name || "");

  if (!matches || alreadyHandled(message.id)) {
    return;
  }

  // Só a palavra-chave (ou quase nada além dela): sem contexto, nem chama a IA.
  if (meaningfulWordCount(message.text) < config.aiMinWords) {
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
    const answer = await askAI(config.preprompt, prompt);

    if (!answer) {
      console.warn("IA respondeu sem texto (possível bloqueio de conteúdo); nada enviado.");
      return;
    }

    // O preprompt manda responder [IGNORE] quando a mensagem não tem contexto real.
    if (answer.includes(IGNORE_MARKER)) {
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
