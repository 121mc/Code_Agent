import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';

// Receive credentials through stdin, never command-line arguments or output.
let temporaryPath;
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const updates = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
  const target = join(resolve(process.argv[2]), '.env');
  let existing = {};
  try {
    existing = parseEnv((await readFile(target, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const keys = ['CODE_AGENT_BASE_URL', 'CODE_AGENT_API_KEY', 'CODE_AGENT_MODEL'];
  for (const key of keys) {
    if (typeof updates[key] !== 'string' || !updates[key].trim()) throw new Error('Invalid configuration.');
    existing[key] = updates[key];
  }
  const lines = Object.entries(existing).map(([key, value]) => {
    // Choose a dotenv quote delimiter that preserves the exact literal value.
    for (const quote of ['"', "'", '`']) {
      if (value.includes(quote)) continue;
      const line = `${key}=${quote}${value}${quote}`;
      if (parseEnv(line)[key] === value) return line;
    }
    throw new Error('Value cannot be represented safely.');
  });
  temporaryPath = join(resolve(process.argv[2]), `.env.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporaryPath, target);
  temporaryPath = undefined;
} catch {
  console.error('Unable to save .env; existing configuration was not replaced.');
  process.exitCode = 1;
} finally {
  if (temporaryPath) await unlink(temporaryPath).catch(() => {});
}
