import { PrismaClient, SessionMode, SessionStatus, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Datos de prueba. Las credenciales son fijas para poder probar el flujo
 * completo (espacio → sesión → dibujar → ganadores) sin fricción.
 */
async function main() {
  console.log('Sembrando datos de PaintOnline…');

  const passwordHash = await bcrypt.hash('Password123', 10);

  // ── Usuarios ────────────────────────────────────────────────────────────
  const ana = await prisma.user.upsert({
    where: { email: 'ana@paintonline.dev' },
    create: {
      email: 'ana@paintonline.dev',
      name: 'Ana Creadora',
      passwordHash,
      role: Role.CREATOR,
      score: { create: { totalPoints: 0 } },
    },
    update: {},
  });

  const bruno = await prisma.user.upsert({
    where: { email: 'bruno@paintonline.dev' },
    create: {
      email: 'bruno@paintonline.dev',
      name: 'Bruno',
      passwordHash,
      score: { create: { totalPoints: 0 } },
    },
    update: {},
  });

  const carla = await prisma.user.upsert({
    where: { email: 'carla@paintonline.dev' },
    create: {
      email: 'carla@paintonline.dev',
      name: 'Carla',
      passwordHash,
      score: { create: { totalPoints: 0 } },
    },
    update: {},
  });

  const diego = await prisma.user.upsert({
    where: { email: 'diego@paintonline.dev' },
    create: {
      email: 'diego@paintonline.dev',
      name: 'Diego',
      passwordHash,
      score: { create: { totalPoints: 0 } },
    },
    update: {},
  });

  // ── Espacio ─────────────────────────────────────────────────────────────
  const space = await prisma.space.upsert({
    where: { slug: 'club-de-dibujo' },
    create: {
      name: 'Club de Dibujo',
      slug: 'club-de-dibujo',
      description: 'Espacio de prueba para dibujar juntos en tiempo real.',
      ownerId: ana.id,
      isPublic: true,
      scoringConfig: { '1': 10, '2': 6, '3': 3 },
      members: {
        create: [
          { userId: ana.id, role: Role.CREATOR },
          { userId: bruno.id, role: Role.VIEWER },
          { userId: carla.id, role: Role.VIEWER },
          { userId: diego.id, role: Role.VIEWER },
        ],
      },
    },
    update: {},
  });

  // ── Una sesión por modo, para probar los tres flujos ────────────────────
  const sessionSpecs: Array<{
    key: string;
    title: string;
    theme: string;
    mode: SessionMode;
    status: SessionStatus;
    layerCount: number;
  }> = [
    {
      key: 'individual',
      title: 'Retrato del club',
      theme: 'Un retrato del resto de los participantes',
      mode: 'INDIVIDUAL',
      status: 'OPEN',
      layerCount: 0,
    },
    {
      key: 'layered',
      title: 'Bosque colectivo',
      theme: 'Bosque, uno atrás de otro',
      mode: 'LAYERED',
      status: 'OPEN',
      layerCount: 4,
    },
    {
      key: 'free',
      title: 'Pizarra libre',
      theme: 'Dibujar lo que quieras',
      mode: 'FREE',
      status: 'OPEN',
      layerCount: 5,
    },
  ];

  for (const spec of sessionSpecs) {
    const existing = await prisma.drawingSession.findFirst({
      where: { spaceId: space.id, title: spec.title },
    });
    if (existing) continue;

    await prisma.drawingSession.create({
      data: {
        spaceId: space.id,
        title: spec.title,
        theme: spec.theme,
        mode: spec.mode,
        status: spec.status,
        layers: {
          create: Array.from({ length: spec.layerCount }, (_, i) => ({
            name: `Capa ${i + 1}`,
            order: i,
            visible: true,
            opacity: 1,
          })),
        },
        // En LAYERED los participantes quedan anotados y cada uno con su capa,
        // que es el estado real después de que entren a la sesión.
        participants:
          spec.mode === 'INDIVIDUAL'
            ? {
                create: [bruno.id, carla.id, diego.id].map((userId) => ({ userId })),
              }
            : spec.mode === 'LAYERED'
              ? { create: [] }
              : { create: [bruno.id, carla.id].map((userId) => ({ userId })) },
      },
    });
  }

  // En LAYERED la capa se asigna al entrar, no al crear. Asignamos a mano para
  // que el seed deje la sesión lista para probar sin conexión previa.
  const layered = await prisma.drawingSession.findFirst({
    where: { spaceId: space.id, mode: 'LAYERED' },
    include: { layers: { orderBy: { order: 'asc' } } },
  });

  if (layered) {
    for (const [index, userId] of [bruno.id, carla.id].entries()) {
      const layer = layered.layers[index];
      if (!layer) continue;
      await prisma.layer.update({
        where: { id: layer.id },
        data: { ownerUserId: userId },
      });
      await prisma.sessionParticipant.upsert({
        where: { sessionId_userId: { sessionId: layered.id, userId } },
        create: { sessionId: layered.id, userId, layerId: layer.id },
        update: { layerId: layer.id },
      });
    }
  }

  console.log('');
  console.log('  Espacio:      /join/club-de-dibujo');
  console.log('  Ana (creadora): ana@paintonline.dev / Password123');
  console.log('  Participantes:  bruno@ / carla@ / diego@paintonline.dev / Password123');
  console.log('');
  console.log('Listo.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
