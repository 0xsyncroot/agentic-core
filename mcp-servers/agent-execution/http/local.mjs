import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The same HTTP service runs directly on the developer's machine, bound to loopback.
process.env.EXECUTION_BIND_HOST = '127.0.0.1';
// The port is chosen here, so a PORT the developer's shell happens to carry must not compete with it.
process.env.EXECUTION_PORT = process.env.EXECUTION_LOCAL_PORT || '8080';
delete process.env.PORT;
process.env.EXECUTION_FILES_DIR ||= join(tmpdir(), `agentic-execution-${process.getuid?.() ?? 'local'}`);
process.env.EXECUTION_ALLOWED_HOSTS ||= 'localhost,127.0.0.1';
process.env.PYTHONDONTWRITEBYTECODE = '1';

await import('./server.mjs');
