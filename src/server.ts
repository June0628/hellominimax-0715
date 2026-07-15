import { serve } from '@hono/node-server';
import app from './index';

const port = parseInt(process.env.PORT || '8000');

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`HelloMinimax running on http://localhost:${info.port}`);
});
