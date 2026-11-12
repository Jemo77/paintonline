'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Link para invitar gente a un espacio.
 *
 * El link es el slug del espacio contra `/join`, que es la ruta pública: con
 * ella se ve el espacio y sus sesiones abiertas, y si ya tenés sesión iniciada
 * te suma al espacio sin pasos de por medio.
 *
 * Se construye con `window.location.origin` y no con una variable de entorno
 * para que funcione detrás de un túnel, un dominio o `localhost` sin tocar la
 * configuración: lo que ve el usuario es lo que se copia.
 */
export function InviteLink({
  slug,
  className,
  label = 'Invitar',
}: {
  slug: string;
  className?: string;
  label?: string;
}) {
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setUrl(`${window.location.origin}/join/${slug}`);
  }, [slug]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const flash = useCallback((ok: boolean) => {
    setCopied(ok);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      flash(true);
    } catch {
      // Sin permiso de clipboard (http sin TLS, iframe): se selecciona el
      // texto para que quede a un Ctrl+C.
      flash(false);
      const input = document.getElementById(`invite-${slug}`);
      if (input instanceof HTMLInputElement) {
        input.select();
      }
    }
  }, [url, slug, flash]);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? 'Ocultar link' : label}
        </button>
        {copied ? <span className="text-xs text-success">¡Copiado!</span> : null}
      </div>

      {open ? (
        <div className="card flex flex-col gap-2 p-3">
          <label
            className="text-xs font-medium"
            htmlFor={`invite-${slug}`}
          >
            Compartí este link con quien quieras dibujar
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={`invite-${slug}`}
              className="input min-w-0 flex-1 font-mono text-xs"
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={copy}>
              Copiar
            </button>
          </div>
          <p className="text-xs text-muted">
            Abre el espacio y muestra sus sesiones abiertas. Si la persona ya
            tiene cuenta, entra directo; si no, se registra y se suma sola.
          </p>
        </div>
      ) : null}
    </div>
  );
}
