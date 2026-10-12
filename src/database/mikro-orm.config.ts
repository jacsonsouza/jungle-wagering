import 'reflect-metadata';

import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { env } from '../config/env.js';

export default defineConfig({
  clientUrl: env.databaseUrl,
  entities: ['./dist/entities'],
  entitiesTs: ['./src/entities'],
  metadataProvider: ReflectMetadataProvider,
  extensions: [Migrator],
  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    transactional: true,
    allOrNothing: true,
  },
});
