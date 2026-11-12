import { DrawingService } from './drawing.service';

describe('DrawingService.broadcastTargets', () => {
  const SESSION = 'sess_1';
  const AUTHOR = 'user_autor';

  it('INDIVIDUAL: sólo el autor y el creador del espacio', () => {
    const targets = DrawingService.broadcastTargets('INDIVIDUAL', SESSION, AUTHOR);

    expect(targets).toEqual([
      { room: `user:${AUTHOR}` },
      { room: `session:${SESSION}:watch` },
    ]);
  });

  it('INDIVIDUAL: nunca emite a la sala completa de la sesión', () => {
    const targets = DrawingService.broadcastTargets('INDIVIDUAL', SESSION, AUTHOR);

    // Si apareciera la sala de la sesión, cualquier participante vería el
    // canvas privado de otro.
    expect(targets.map((t) => t.room)).not.toContain(`session:${SESSION}`);
  });

  it('LAYERED: toda la sala de la sesión', () => {
    const targets = DrawingService.broadcastTargets('LAYERED', SESSION, AUTHOR);

    expect(targets).toEqual([{ room: `session:${SESSION}` }]);
  });

  it('FREE: toda la sala de la sesión', () => {
    const targets = DrawingService.broadcastTargets('FREE', SESSION, AUTHOR);

    expect(targets).toEqual([{ room: `session:${SESSION}` }]);
  });

  it('el autor recibe siempre su propio trazo, en los tres modos', () => {
    for (const mode of ['INDIVIDUAL', 'LAYERED', 'FREE'] as const) {
      const targets = DrawingService.broadcastTargets(mode, SESSION, AUTHOR);
      const rooms = targets.map((t) => t.room);

      if (mode === 'INDIVIDUAL') {
        expect(rooms).toContain(`user:${AUTHOR}`);
      } else {
        // En LAYERED/FREE el autor está dentro de la sala de la sesión.
        expect(rooms).toContain(`session:${SESSION}`);
      }
    }
  });
});

describe('DrawingService (nombres de salas)', () => {
  it('aisla las salas por sesión y por usuario', () => {
    expect(DrawingService.sessionRoom('a')).toBe('session:a');
    expect(DrawingService.sessionRoom('b')).toBe('session:b');
    expect(DrawingService.watchRoom('a')).toBe('session:a:watch');
    expect(DrawingService.userRoom('u1')).toBe('user:u1');
  });

  it('la sala :watch no colisiona con la sala de la sesión', () => {
    // Sin el prefijo distinto, un socket del creador en :watch entraría también
    // en la sala normal y rompería el aislamiento de INDIVIDUAL.
    expect(DrawingService.watchRoom('a')).not.toBe(DrawingService.sessionRoom('a'));
  });
});
