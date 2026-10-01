import { createLambdaHandler } from './app.ts';
import { dynamoHealthStore } from './health-store.ts';
import { ssmStore } from './store.ts';

export const handler = createLambdaHandler({
  store: ssmStore(),
  health: dynamoHealthStore(process.env.TABLE_NAME ?? ''),
  timeZone: process.env.USER_TZ || 'UTC',
  allowTestClock: process.env.ALLOW_TEST_CLOCK === 'true',
});
