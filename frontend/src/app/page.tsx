import Link from 'next/link';

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-10 px-6 py-16">
      <header className="flex items-center justify-between">
        <span className="text-lg font-bold tracking-tight">PaintOnline</span>
        <nav className="flex items-center gap-4 text-sm">
          <Link className="text-muted hover:opacity-80" href="/login">
            Iniciar sesión
          </Link>
          <Link className="btn btn-primary btn-sm" href="/spaces">
            Crear un espacio
          </Link>
        </nav>
      </header>

      <section className="flex flex-col gap-6">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Dibujar juntos, en tiempo real.
        </h1>
        <p className="max-w-2xl text-lg text-muted">
          Creador de espacios, creás una sesión con un tema, eligen el modo y
          todos dibujan al mismo tiempo. Cuando termine, el creador elige tres
          ganadores y el ranking se actualiza solo.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link className="btn btn-primary" href="/register">
            Empezar gratis
          </Link>
          <Link className="btn btn-secondary" href="/login">
            Ya tengo cuenta
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <ModeCard
          title="Individual"
          body="Cada participante dibuja en su propio canvas privado. El creador los ve a todos en un grid en vivo."
        />
        <ModeCard
          title="Por capas"
          body="Un solo canvas compartido. Cada quien recibe una capa exclusiva y todos ven el combinado al instante."
        />
        <ModeCard
          title="Libre"
          body="Capas compartidas, cualquiera dibuja donde quiera y cambia de capa cuando quiere."
        />
      </section>

      <section className="card flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Tus dibujos no salen de tu máquina</h2>
        <p className="text-sm text-muted">
          El servidor guarda trazos vectoriales, nunca imágenes. Si querés
          llevarte el resultado, el PNG se genera en tu navegador y se descarga
          directo a tu computadora. No hay almacenamiento de archivos, ni S3, ni
          costos por guarda.
        </p>
      </section>
    </main>
  );
}

function ModeCard({ title, body }: { title: string; body: string }) {
  return (
    <article className="card flex flex-col gap-2">
      <h3 className="font-semibold">{title}</h3>
      <p className="text-sm text-muted">{body}</p>
    </article>
  );
}
