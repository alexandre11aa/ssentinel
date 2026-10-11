# SSentinel

Sentinela de um grupo do WhatsApp (Baileys): **recebe** as mensagens do grupo e **envia** texto/imagem, tudo por uma API HTTP protegida por token.

## Subir

```bash
docker compose up -d --build
docker logs -f ssentinel     # escaneie o QR Code no primeiro start
```

Sessão fica em `./data/auth` (não perca, senão precisa parear de novo).

## Configurar o grupo

1. Com o serviço conectado: `GET /groups` → copie o `jid` do grupo.
2. Cole em `WHATSAPP_GROUP_JID` no `.env` e `docker compose restart`.

## Autenticação

Todos os endpoints, exceto `/health`, exigem o `API_TOKEN` do `.env`:

```
Authorization: Bearer <token>      (ou)      x-api-key: <token>
```
