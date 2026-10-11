import path from "node:path";

// Todas as configurações vêm de variáveis de ambiente (.env), com valores padrão.
export const config = {
  // Porta da API HTTP.
  port: Number(process.env.PORT || 8082),
  // Token exigido nos endpoints protegidos.
  apiToken: process.env.API_TOKEN || "",
  // JID do grupo monitorado (termina em @g.us). Vazio = descobrir via GET /groups.
  groupJid: (process.env.WHATSAPP_GROUP_JID || "").trim(),
  // Pasta onde o Baileys guarda a sessão do WhatsApp.
  authDirectory: path.resolve(process.env.WHATSAPP_AUTH_PATH || "./data/auth"),
  // Quantas vezes o QR Code é regerado antes de desistir.
  maxQrAttempts: Number(process.env.WHATSAPP_MAX_QR_ATTEMPTS || 3),
  // Quantidade de mensagens mantidas em memória (GET /messages).
  bufferSize: Number(process.env.MESSAGE_BUFFER_SIZE || 500),
  logLevel: process.env.LOG_LEVEL || "warn",

  // --- IA (Gemini) ---
  // Sem chave, a resposta automática fica desligada.
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
  // Palavras que disparam a IA (basta uma delas), separadas por vírgula.
  aiKeywords: (process.env.AI_KEYWORDS || "ssentinel")
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean),
  // Preprompt: instruções enviadas ao Gemini junto da mensagem do grupo.
  preprompt: (process.env.PREPROMPT || "").trim(),
  // Quantas mensagens de texto anteriores à palavra-chave vão como contexto (0 = nenhuma).
  aiContextMessages: Number(process.env.AI_CONTEXT_MESSAGES ?? 5),
  // Modo debug: true = a IA também responde às mensagens do próprio número do bot.
  aiDebug: (process.env.DEBUG || "false").trim().toLowerCase() === "true",
  // Limite de chamadas à IA por minuto (evita spam e estouro de cota).
  aiMaxPerMinute: Number(process.env.AI_MAX_PER_MINUTE || 5),
  // Tamanho máximo da resposta da IA, em tokens.
  aiMaxOutputTokens: Number(process.env.AI_MAX_OUTPUT_TOKENS || 500),
};

/**
 * Valida a configuração obrigatória. Lança erro e impede o serviço de subir.
 */
export function validateConfig() {
  if (config.apiToken.length < 32) {
    throw new Error("API_TOKEN ausente ou curto demais (mínimo 32 caracteres).");
  }

  if (config.groupJid && !config.groupJid.endsWith("@g.us")) {
    throw new Error("WHATSAPP_GROUP_JID inválido: deve terminar em @g.us.");
  }
}
