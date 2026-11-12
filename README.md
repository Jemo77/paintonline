# PaintOnline

Dibujo colaborativo en tiempo real. NestJS + Socket.io + PostgreSQL + Redis en el
backend, Next.js + Konva en el frontend.

**Estado:** MVP funcional con sesiones colaborativas, capas, ranking, historial y exportación local.

**No hay object storage.** Los trazos se guardan como vectores en PostgreSQL y el
PNG se genera en el navegador con `stage.toDataURL()`. El servidor nunca ve una
imagen.

## Los tres modos de sesión

El modo es lo único que cambia el enrutado de un trazo. Todo se resuelve con
salas de socket.io, así que no hay un `if` por socket en el medio:

| Modo | Quién ve el trazo | Capas | Premiación |
| --- | --- | --- | --- |
| `INDIVIDUAL` | sólo el autor y el creador del espacio | ninguna (`Stroke.userId` aísla) | 1º/2º/3º |
| `LAYERED` | toda la sala | una por participante, asignada al entrar | 1º/2º/3º |
| `FREE` | toda la sala | compartidas, con candado opcional | no premia |

En `INDIVIDUAL` el creador entra en la sala `session:<id>:watch` y por eso ve
todos los canvas a la vez, en un grid de miniaturas, sin que el backend mezcle
nunca dos participantes.

## Levantar el proyecto

Requisitos: Node 20+, PostgreSQL 14+ y Redis 6+ (o Docker).

```bash
# 1. Infraestructura (o traé tu propio postgres/redis)
cd backend
docker compose up -d db redis

# 2. Backend
cp .env.example .env
npm install
npx prisma migrate deploy     # o `npx prisma migrate dev` mientras desarrollás
npm run prisma:seed
npm run start:dev             # http://localhost:3001/api  ·  ws://localhost:3001/session

# 3. Frontend, en otra terminal
cd ../frontend
cp .env.example .env
npm install
npm run dev                   # http://localhost:3000
```

Con Docker para las tres cosas:

```bash
cd backend && docker compose up --build
```

### Exponerlo con un túnel (Cloudflare, ngrok, Tailscale…)

El navegador no puede llamar a `http://localhost:3001`: `localhost` ahí es **la
máquina de quien abrió la página**, no el servidor. Con un túnel que sólo expone
el frontend, la API y el WebSocket quedan inalcanzables.

La solución es servir ambas cosas desde **un único origen**. `npm run proxy`
levanta un proxy sin dependencias que escucha en `:3002` y reparte:

| Origen | Ruta | Va a |
| --- | --- | --- |
| `:3002` | `/api/*`, `/socket.io/*`, `/health*` | backend `:3001` |
| `:3002` | todo lo demás (`/`, `/_next/*`, `/s/*`…) | Next `:3000` |

```bash
# en una terminal, con backend y frontend ya levantados
cd frontend && npm run proxy          # http://localhost:3002

# en otra
cloudflared tunnel --url http://localhost:3002
```

Apuntá el túnel a **`:3002`**, no a `:3000`. A partir de ahí `localhost`, un
dominio y el túnel se comportan igual, sin CORS que configurar y sin exponer el
backend. El HMR de `next dev` también atraviesa el túnel, así que recargar
sigue actualizando el código.

Para comprobar que un origen sirve frontend **y** backend:

```bash
cd frontend && npm run check:proxy -- http://localhost:3002
```

Levanta un socket real contra ese origen y verifica que entra por `join_session`
y recibe el estado de la sesión. Es el mismo camino que recorre el navegador, así
que si el check pasa, el túnel sirve.

> **Por qué un proxy y no `rewrites` de Next.** `next.config.ts` puede
> reenviar `/api` al backend, pero los rewrites no soportan el upgrade de
> WebSocket, y `/socket.io/` además recibe un 308 por la barra final. Un
> WebSocket necesita un pipe a nivel de socket TCP, que sólo se puede hacer por
> fuera de Next.

Si preferís que el frontend y el backend vivan en hosts distintos, definí
`NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` con la URL absoluta del backend y
agregá el origen del frontend a `CORS_ORIGINS` del backend.

### Usuarios de prueba

El seed crea el espacio `club-de-dibujo` y una sesión por modo. Todos con
contraseña `Password123`:

| Email | Rol |
| --- | --- |
| `ana@paintonline.dev` | creadora del espacio |
| `bruno@paintonline.dev` | miembro |
| `carla@paintonline.dev` | miembro |
| `diego@paintonline.dev` | miembro |

## Comandos

```bash
# backend
npm run typecheck      # tsc --noEmit
npm test               # jest (unitarios de routing y score)
npm run build          # nest build
npm run e2e            # extremo a extremo contra un backend corriendo
npm run prisma:studio  # explorar la base

# frontend
npm run typecheck
npm run build
npm run lint
npm run proxy        # origen único (:3002) para exponer con un túnel
npm run check:proxy  # verifica que un origen sirve REST + WebSocket
```

`npm run e2e` levanta tres sockets reales contra `localhost:3001` y verifica, entre
otras cosas, que en `INDIVIDUAL` un tercero no recibe los trazos ajenos, que en
`LAYERED` el servidor ignora la capa que pide el cliente, y que elegir ganadores
revierte los puntos anteriores antes de aplicar los nuevos.

## Estructura

```
backend/
  prisma/schema.prisma     User, Space, SpaceMember, DrawingSession,
                           SessionParticipant, Layer, Stroke, SessionWinner,
                           UserScore, RefreshToken, ExportLog
  src/
    auth/                  JWT propio (access + refresh), guardas REST y WS
    spaces/                espacios, membresías, config de scoring
    sessions/              ciclo de vida, participantes, capas, ganadores
    drawing/               gateway, buffer de trazos, presencia, locks
    ranking/               puntos con caché en Redis
    events/                puente service → gateway (sin dependencias de negocio)
    redis/                 RedisService + IoAdapter con redis-adapter
frontend/
  src/
    app/                   rutas de Next (App Router)
    components/canvas/     CanvasStage (Konva), Toolbar, LayerPanel, export
    components/ranking/    RankingTable, WinnerPicker
    hooks/useCanvasSync    socket + batching de puntos a 24 ms
    store/canvasStore      estado del canvas (Zustand)
    utils/exportCanvas     PNG 100 % local
    lib/api.ts             cliente REST con refresh de un solo vuelo
  scripts/
    tunnel-proxy.mjs       origen único (:3002) para exponer con un túnel
    check-proxy.mjs        comprueba que un origen sirve REST + WebSocket
```

## Decisiones que conviene conocer

**Namespace `/session` + salas, no `/session/:sessionId`.** El spec original
usaba un namespace por sesión. Acá hay un solo namespace y el `join_session` mete
el socket en las salas correspondientes. El resultado es el mismo pero se puede
reconectar a otra sesión sin cambiar de URL, y la sala es la unidad sobre la que
se decide el aislamiento.

**El buffer de trazos vive en Redis, no en memoria.** `stroke:buf:<id>` es una
lista y `stroke:meta:<id>` su metadata, con TTL de 5 minutos. Así cualquier
instancia del gateway puede cerrar un trazo que se abrió en otro nodo, que es lo
que hace falta para escalar horizontalmente. Un trazo que nunca recibe
`stroke_end` se descarta solo.

**Puntos por batch, no por punto.** A 120 Hz, un evento por punto son 120 viajes
de ida y vuelta por segundo. Los puntos del mismo frame van en un array
(`MAX_POINTS_PER_EVENT=64`) y hay un token bucket por socket
(`WS_RATE_LIMIT`/`WS_RATE_BURST`).

**El undo es borrado lógico.** `Stroke.isErased` en vez de `DELETE`: el redo
necesita el trazo y el historial se reconstruye sin perder lo que se deshecho.

**Un solo token para REST y WebSocket.** El access token viaja en
`handshake.auth.token`; el gateway valida la identidad una sola vez y la cachea
en `client.data.user`. Ningún evento acepta `userId` desde el cliente: si lo
aceptara, cualquiera podría dibujar en nombre de otro.

**El cliente habla siempre en relativo.** `/api` y `/socket.io` se piden
relativos a la página, así que el mismo código funciona en `localhost`, en un
dominio y detrás de un túnel sin tocar variables. La URL del backend se
resuelve en el servidor (`NEXT_PUBLIC_API_URL` sólo hace falta si el frontend
y el backend están en hosts distintos). Ver
[Exponerlo con un túnel](#exponerlo-con-un-túnel-cloudflare-ngrok-tailscale).

**`react-konva` está pinado a `~19.2`.** Next 15 sirve su propia copia vendorizada
de React (19.2-canary) y `react-konva@19.3` exige React 19.3 o superior, así que
con la 19.2 falla al importar. Subir a Next 16 libera la 19.3.

**`konva` está aliaseado al build de navegador** en `next.config.ts`. El `main`
del paquete es `index-node.js`, que hace `require('canvas')` — un paquete nativo
que no queremos en el bundle. Para el render del servidor sólo hacen falta los
tipos: el `Stage` real se monta en un efecto del cliente.

## Rutas de la API

Todo cuelga de `/api` y salvo el login necesita `Authorization: Bearer`.

```
POST   /auth/register | /auth/login | /auth/refresh | /auth/logout
GET    /auth/me

GET    /spaces                                   espacios del usuario
POST   /spaces
GET    /spaces/public/:slug                      vista pública (sin token)
GET    /spaces/:spaceId
PATCH  /spaces/:spaceId
GET    /spaces/:spaceId/members
POST   /spaces/:spaceId/join | /leave

POST   /spaces/:spaceId/sessions
GET    /spaces/:spaceId/sessions
GET    /sessions/:sessionId
PATCH  /sessions/:sessionId
DELETE /sessions/:sessionId
POST   /sessions/:sessionId/join | /leave
GET    /sessions/:sessionId/participants
POST   /sessions/:sessionId/layers
PUT    /sessions/:sessionId/layers/:layerId
DELETE /sessions/:sessionId/layers/:layerId
GET    /sessions/:sessionId/strokes?userId&layerId&before&limit
GET    /sessions/:sessionId/strokes/count
POST   /sessions/:sessionId/exports              sólo analítica
PUT    /sessions/:sessionId/winners

GET    /ranking/space/:spaceId?page&pageSize
GET    /ranking/global?spaceId&page&pageSize
GET    /ranking/me
GET    /ranking/history/:userId

GET    /health  ·  /health/ready
```

## Eventos del WebSocket

Namespace `ws://<api>/session`. El token va en el handshake (`auth.token`).

**Cliente → servidor:** `join_session`, `leave_session`, `stroke_start`,
`stroke_points`, `stroke_end`, `stroke_abort`, `undo`, `redo`, `layer_switch`,
`release_layer_lock`, `heartbeat`.

**Servidor → cliente:** `session_state_sync` (respuesta al join, con el estado
completo), `stroke_started`, `stroke_draft` (puntos en vuelo), `stroke_broadcast`
(trazo ya persistido), `stroke_removed`, `presence_update`, `layer_lock_update`,
`layer_changed`, `layer_removed`, `winners_announced`, `session_closed`,
`session_updated`, `error`.

## Desviaciones del spec original

- **Namespace `/session` con salas** en lugar de `/session/:sessionId`. Misma
  semántica de routing, más robusta ante reconexiones.
- **`strokeId` es opcional en `stroke_start`.** Si el cliente lo manda se usa
  (evita esperar un round-trip antes del primer punto); si no, lo genera el
  servidor.
- **Sin generación de imágenes en el servidor.** La exportación es 100 % local
  por diseño; el endpoint de exports sólo registra que hubo una descarga.
- **Se agregaron `RefreshToken`, `Space.scoringConfig` y `Stroke.isErased`** al
  schema, más los índices de `Stroke` por sesión y por usuario. El refresh
  revocable y el undo/redo los necesitan.

---

## Autoría

Proyecto personal de **Jorge Martín** ([Jemo77](https://github.com/Jemo77)).
