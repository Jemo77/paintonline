import { Global, Module } from '@nestjs/common';
import { SessionEventsService } from './session-events.service';

/**
 * Módulo sin dependencias de negocio. Existe para romper el ciclo que habría
 * entre `DrawingModule` (necesita SessionsService) y `SessionsModule`
 * (necesita avisar por socket cuando se eligen ganadores o se cierra la sesión).
 */
@Global()
@Module({
  providers: [SessionEventsService],
  exports: [SessionEventsService],
})
export class SessionEventsModule {}
