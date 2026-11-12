import path from 'node:path';
import type { NextConfig } from 'next';

const konvaBrowserBuild = path.resolve(process.cwd(), 'node_modules/konva/lib/index.js');

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * `next dev` bloquea los assets de /_next* cuando la petición viene de un
   * origen que no reconoce. Con un túnel de Cloudflare el host es un subdominio
   * aleatorio, así que se permite el comodín. Sólo afecta al desarrollo; en
   * `next build` no hay chequeo de origen.
   */
  allowedDevOrigins: ['*.trycloudflare.com', '*.localhost'],

  /**
   * react-konva toca `window` al importarse. Se carga sólo en el cliente;
   * los componentes que lo usan están marcados con 'use client'.
   */
  transpilePackages: ['react-konva', 'konva'],

  /**
   * Konva declara `main: lib/index-node.js`, que a su vez hace
   * `require('canvas')` — un paquete nativo que no queremos en el bundle de
   * Next. Para el render del servidor sólo hacen falta los tipos: el `Stage`
   * real se monta en un efecto del cliente, así que forzamos el build de
   * navegador y le damos a `canvas` un módulo vacío.
   */
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      canvas: false,
      konva$: konvaBrowserBuild,
    };
    return config;
  },

  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
