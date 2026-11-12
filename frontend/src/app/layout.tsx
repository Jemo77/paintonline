import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PaintOnline — Sesiones de dibujo colaborativo en tiempo real',
  description:
    'Creá espacios, abrí sesiones de dibujo y compartí canvas en vivo. Cada quien descarga su obra desde el navegador.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
