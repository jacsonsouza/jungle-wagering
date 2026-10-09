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
  // TODO(phase-2): remove this once `src/entities/` holds real entities.
  // The scaffold boots before the domain layer exists, and MikroORM refuses
  // to start when a glob resolves to zero entities. Re-enabling it is what
  // makes a broken entity path fail loudly instead of silently.
  discovery: {
    warnWhenNoEntities: false,
  },
  extensions: [Migrator],
  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    transactional: true,
    allOrNothing: true,
  },
});
