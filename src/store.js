import { config } from "./config.js";

// Buffer em memória das últimas mensagens (perdido ao reiniciar o serviço).
const messages = [];
// IDs das mensagens no buffer, para detectar duplicatas em O(1).
const seenIds = new Set();

/**
 * Guarda a mensagem no buffer circular. Retorna false se já tinha sido vista.
 */
export function addMessage(message) {
  if (seenIds.has(message.id)) {
    return false;
  }

  seenIds.add(message.id);
  messages.push(message);

  // Descarta as mais antigas ao passar do limite, liberando também o ID.
  while (messages.length > config.bufferSize) {
    const removed = messages.shift();
    seenIds.delete(removed.id);
  }

  return true;
}

/**
 * Últimas `limit` mensagens com texto de um grupo (mais antigas primeiro),
 * sem contar a mensagem `excludeId`. Serve de contexto para a IA.
 */
export function recentTextMessages({ groupJid, limit, excludeId }) {
  if (limit <= 0) {
    return [];
  }

  return messages
    .filter(
      (message) =>
        message.group_jid === groupJid && message.text && message.id !== excludeId,
    )
    .slice(-limit);
}

/**
 * Lista mensagens (mais antigas primeiro), opcionalmente só as posteriores
 * a `since` (timestamp em segundos) e limitadas às últimas `limit`.
 */
export function listMessages({ since = 0, limit = 100 } = {}) {
  const filtered = messages.filter((message) => message.timestamp > since);

  return filtered.slice(-limit);
}
