import { Module } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { NotesModule } from '../features/notes/notes.module.js';
import { DemoSeeder } from './demo-seeder.js';

/**
 * The app with the demo seed: what `pnpm db:seed:demo` boots
 * (seed-demo.ts), never the API or the worker. IAM's and the platform's
 * services are global; the notes' service is NotesModule's export.
 */
@Module({
  imports: [AppModule, NotesModule],
  providers: [DemoSeeder],
})
export class DemoSeedModule {}
