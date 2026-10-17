import { z } from 'zod';

// Zod probes `new Function('')` when the first schema is built, to compile faster
// parsers. The Content-Security-Policy (caddy/Caddyfile) has no 'unsafe-eval', so the
// caught probe would still be reported as a violation. `jitless` skips it.
// Import `z` from here, not from 'zod': config must be set before any schema exists,
// and modules with module-level schemas load before main.tsx's own code runs.
z.config({ jitless: true });

export { z };
