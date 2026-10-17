import { Module } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { DemoSeeder } from './demo-seeder.js';

/**
 * The app with the demo seed: what `pnpm db:seed:demo` boots
 * (seed-demo.ts), never the API or the worker. IAM's and the platform's
 * services are global; the features' demo seeders are their modules'
 * (`FeatureDefinition.demo`), found through the module graph.
 */
@Module({
  imports: [AppModule],
  providers: [DemoSeeder],
})
export class DemoSeedModule {}
