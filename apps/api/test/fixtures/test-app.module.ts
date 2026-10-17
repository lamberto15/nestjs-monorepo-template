import { createAppModule } from '../../src/app.module.js';
import { FEATURES } from '../../src/features/index.js';
import { TEST_ITEMS_FEATURE } from './test-items/test-items.feature.js';

/**
 * What the tests boot by default (support.ts bootApp): the app's features
 * and the test-only ones, so the platform's tests have a record of their
 * own (TestItem) whatever features a project keeps.
 */
export const TestAppModule = createAppModule([...FEATURES, TEST_ITEMS_FEATURE]);
