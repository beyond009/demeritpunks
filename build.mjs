import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const asset of ['index.html', 'inc', 'audio']) {
  await cp(join(root, asset), join(output, asset), { recursive: true });
}

// The SDK is a standalone browser module; the rest of the site stays static.
const sdk = await readFile(join(root, 'node_modules/@vercel/analytics/dist/index.mjs'), 'utf8');
await writeFile(join(output, 'inc/vercel-analytics.mjs'), sdk.replace(/^\/\/# sourceMappingURL=.*$/m, ''));

// Vercel provides the public intake paths at build time.
const config = process.env.VERCEL_OBSERVABILITY_CLIENT_CONFIG || '';
const entry = `import { inject } from './vercel-analytics.mjs';\n` +
  `inject({ mode: 'production', framework: 'html', debug: false }, ${JSON.stringify(config)});\n`;
await writeFile(join(output, 'inc/analytics.js'), entry);
console.log('Built static site with Vercel Web Analytics.');
