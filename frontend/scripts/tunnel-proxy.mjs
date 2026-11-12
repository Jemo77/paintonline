/**
 * Proxy de un solo origen para exponer la app detrás de un túnel.
 *
 *   navegador ──► tunnel ──► ESTE proxy (:3002) ──┬─► Next  (:3000)  /_next, /, /s/…
 *                                                └─► Nest  (:3001)  /api, /socket.io, /health
 *
 * Por qué existe esto y no alcanza con `rewrites` de Next:
 *
 *   1. El navegador resuelve `localhost:3001` a su propia máquina. Con un
 *      túnel público, la API y el WebSocket nunca llegan al backend.
 *      Sirviendo ambas cosas desde el mismo origen se evita por completo.
 *   2. `next.config.ts` puede reenviar `/api`, pero los rewrites de Next no
 *      soportan el upgrade de WebSocket (`/socket.io/` además recibe un 308
 *      por la barra final). Hace falta un proxy que pipee el upgrade, y eso
 *      sólo se puede hacer a nivel de socket, fuera de Next.
 *   3. Como efecto secundario, el HMR de `next dev` también atraviesa el
 *      túnel, así que recargar la página sigue actualizando el código.
 *
 * Sólo se usan módulos nativos de Node: no agrega dependencias.
 *
 * Variables:
 *   PROXY_PORT       puerto de este proxy            (3002)
 *   FRONTEND_ORIGIN  origen de Next                   (http://127.0.0.1:3000)
 *   BACKEND_ORIGIN   origen del backend Nest          (http://127.0.0.1:3001)
 */
import http from 'node:http';
import net from 'node:net';

/** Prefijos que van al backend. El resto va al frontend. */
const BACKEND_PREFIXES = ['/api', '/socket.io', '/health'];

const PORT = Number(process.env.PROXY_PORT ?? 3002);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'http://127.0.0.1:3000';
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:3001';

/** `/socket.io` exacto o con subpath, pero no `/socket.iotest`. */
function goesToBackend(url) {
  const path = (url ?? '/').split('?')[0];
  return BACKEND_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

function originOf(url) {
  return goesToBackend(url) ? BACKEND_ORIGIN : FRONTEND_ORIGIN;
}

const server = http.createServer((req, res) => {
  const target = originOf(req.url);
  const targetHost = new URL(target).host;

  const proxyReq = http.request(
    `${target}${req.url}`,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: targetHost,
        'x-forwarded-host': req.headers.host ?? '',
        'x-forwarded-proto': 'https',
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ statusCode: 502, message: `Upstream no responde: ${target}` }));
    console.error(`[proxy] ${req.method} ${req.url} → ${target}: ${err.message}`);
  });

  req.pipe(proxyReq);
});

/**
 * Upgrade de WebSocket. Next no lo soporta en los rewrites, así que aquí se
 * reenvía la petición en crudo sobre un socket TCP y se pipdean las dos
 * direcciones. Vale tanto para el gateway de dibujo (`/socket.io`) como para
 * el HMR de Next (`/_next/webpack-hmr`).
 */
server.on('upgrade', (req, socket, head) => {
  const target = new URL(originOf(req.url));
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));

  const upstream = net.connect(port, target.hostname, () => {
    const headers = [
      `${req.method} ${req.url} HTTP/1.1`,
      `Host: ${target.host}`,
      // `X-Forwarded-Proto: https` para que el backend no piense que el
      // cliente habla en claro; el túnel termina TLS aquí.
      'X-Forwarded-Proto: https',
    ];

    // Se copia la petición original tal cual, salvo el Host (que debe
    // apuntar al upstream) y los headers hop-by-hop de la conexión previa.
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      if (name.toLowerCase() === 'host') continue;
      headers.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }

    upstream.write(`${headers.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);

    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on('error', (err) => {
    console.error(`[proxy] upgrade ${req.url}: ${err.message}`);
    socket.destroy();
  });
  socket.on('error', () => upstream.destroy());
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[proxy] el puerto ${PORT} ya está ocupado. ` +
        'Matá el proxy anterior o cambiá el puerto con PROXY_PORT=3003.',
    );
    process.exit(1);
  }
  console.error(`[proxy] ${err.message}`);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] escuchando en http://localhost:${PORT}`);
  console.log(`[proxy]   → backend  ${BACKEND_ORIGIN}  (${BACKEND_PREFIXES.join(', ')})`);
  console.log(`[proxy]   → frontend ${FRONTEND_ORIGIN}`);
  console.log('[proxy] apuntá el túnel a este puerto, no al de Next.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
