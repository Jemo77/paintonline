'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useAuth } from '@/lib/useAuth';

function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { register } = useAuth();

  // Si xtraen ?space=club-de-dibujo, la cuenta se une al espacio al crearse.
  const spaceSlug = params.get('space') ?? undefined;

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register({ name, email, password, spaceSlug });
      router.push(spaceSlug ? `/s` : '/spaces');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear la cuenta');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Crear cuenta</h1>
        {spaceSlug ? (
          <p className="text-sm text-muted">
            Te vas a sumar al espacio{' '}
            <span className="font-mono">{spaceSlug}</span> y después vas a poder
            entrar a sus sesiones abiertas.
          </p>
        ) : (
          <p className="text-sm text-muted">Para crear y administrar espacios.</p>
        )}
      </div>

      <form className="card flex flex-col gap-3" onSubmit={handleSubmit}>
        <div>
          <label className="label" htmlFor="name">
            Nombre
          </label>
          <input
            id="name"
            className="input"
            required
            minLength={2}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor="password">
            Contraseña
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">
            Mínimo 8 caracteres, con minúscula, mayúscula y un número.
          </p>
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}

        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Creando…' : 'Crear cuenta'}
        </button>
      </form>

      <p className="text-center text-sm text-muted">
        ¿Ya tenés cuenta?{' '}
        <Link className="text-[var(--primary)]" href="/login">
          Iniciá sesión
        </Link>
      </p>
    </main>
  );
}

export default function RegisterPage() {
  // useSearchParams necesita Suspense para no romper el prerender estático.
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}
