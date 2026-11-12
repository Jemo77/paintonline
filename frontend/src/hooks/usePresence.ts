'use client';

import { useMemo } from 'react';
import { useCanvasStore } from '@/store/canvasStore';
import type { Participant, PresenceEntry } from '@/types';

/**
 * Presencia derivada.
 *
 * En INDIVIDUAL cada participante sólo ve su propio canvas, así que la
 * presencia útil es la del creador (que monitorea a todos). En LAYERED y FREE
 * todos ven el mismo canvas, con lo que alcanza la lista completa.
 */
export interface PresenceView {
  users: PresenceEntry[];
  byUserId: Map<string, PresenceEntry>;
  onlineCount: number;
  drawingCount: number;
  /** Ids de usuarios conectados y actualmente dibujando. */
  drawingUserIds: Set<string>;
}

export function usePresence(mode: 'INDIVIDUAL' | 'LAYERED' | 'FREE'): PresenceView {
  const presence = useCanvasStore((s) => s.presence);

  return useMemo(() => {
    const byUserId = new Map(presence.map((p) => [p.userId, p]));
    const drawingUserIds = new Set(
      presence.filter((p) => p.drawing).map((p) => p.userId),
    );

    return {
      users: presence,
      byUserId,
      onlineCount: presence.length,
      drawingCount: drawingUserIds.size,
      drawingUserIds,
    };
  }, [presence, mode]);
}

/**
 * Participantes anotados, con su estado de conexión.
 * El store guarda los anotados en la BD; la presencia viene de Redis. Se
 * combinan para que la UI pueda mostrar "3 de 5 dibujan".
 */
export function useParticipants() {
  const participants = useCanvasStore((s) => s.participants);
  const presence = useCanvasStore((s) => s.presence);

  return useMemo(() => {
    const online = new Set(presence.map((p) => p.userId));

    return participants.map((p) => ({
      ...p,
      isOnline: online.has(p.userId),
      isDrawing: online.has(p.userId) && presence.find((x) => x.userId === p.userId)?.drawing === true,
    }));
  }, [participants, presence]);
}

export type ParticipantWithPresence = Participant & {
  isOnline: boolean;
  isDrawing: boolean;
};
