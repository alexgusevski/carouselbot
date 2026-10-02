import { execFileSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const configName = 'wrangler.product.production.jsonc';
const requiredSecrets = ['OPENROUTER_API_KEY', 'POLAR_ACCESS_TOKEN', 'POLAR_WEBHOOK_SECRET', 'TURNSTILE_SECRET_KEY'];
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

export function validateProductProductionConfig(config) {
  const vars = config.vars || {};
  requireValue(config.name === 'carouselbot-product' && config.account_id === '0013d6c77fa95280762f403d53c52869', 'the Worker must target the production CarouselBot account and name.');
  requireValue(config.main === 'backend/worker.mjs' && config.workers_dev === false, 'use the product Worker entrypoint with workers.dev disabled.');
  requireValue(vars.APP_ORIGIN === 'https://carousel.bot', 'APP_ORIGIN must be https://carousel.bot.');
  requireValue(config.routes?.length === 1 && config.routes[0].pattern === 'carousel.bot/*' && config.routes[0].zone_name === 'carousel.bot' && config.routes[0].custom_domain !== true, 'configure only the intended carousel.bot/* zone route after live verification.');
  requireValue(config.assets?.binding === 'ASSETS' && config.assets.run_worker_first === true, 'all static requests must pass through product security headers.');
  requireValue(/^pk_live_[A-Za-z0-9+/=_-]+$/.test(vars.CLERK_PUBLISHABLE_KEY || ''), 'configure a live Clerk publishable key.');
  const clerkHost = Buffer.from(vars.CLERK_PUBLISHABLE_KEY.split('_').slice(2).join('_'), 'base64').toString('utf8').replace(/\$$/, '');
  requireValue(/^[a-z0-9.-]+\.carousel\.bot$/i.test(clerkHost), 'the live Clerk frontend must belong to carousel.bot.');
  try { requireValue(createPublicKey(vars.CLERK_JWT_KEY).asymmetricKeyType === 'rsa', 'use the live Clerk RSA public verification key.'); }
  catch { throw new Error('configure the live Clerk PEM public verification key.'); }
  requireValue(vars.POLAR_ENVIRONMENT === 'production' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(vars.POLAR_PRODUCT_ID || '') && vars.POLAR_PRODUCT_ID !== '00000000-0000-0000-0000-000000000000', 'configure the approved live Polar product.');
  requireValue(Number(vars.AGENT_ALLOWANCE_USD) === 5 && Number(vars.JOB_BUDGET_USD) === .5, 'the $19 plan must retain its 500 monthly credits and 50-credit request limit.');
  requireValue(config.d1_databases?.some(binding => binding.binding === 'DB' && binding.database_name === 'carouselbot-product' && binding.database_id === 'aad4c84f-495f-4374-a2b4-fc9e330da1e3'), 'use the separate provisioned production product database.');
  requireValue(config.r2_buckets?.some(binding => binding.binding === 'ASSETS_BUCKET' && binding.bucket_name === 'carouselbot-product') && config.workflows?.some(binding => binding.binding === 'AGENT_WORKFLOW' && binding.name === 'carouselbot-agent') && config.browser?.binding === 'BROWSER', 'bind the separate production media, Workflow and Browser Run resources.');
  requireValue(vars.PRODUCT_SHARING_MODE === 'direct' && vars.SHARING_ENABLED === 'true' && vars.TURNSTILE_SITE_KEY === '0x4AAAAAAFDBOVqLSqypczL7', 'preserve direct production sharing and its existing Turnstile site key.');
  requireValue(config.kv_namespaces?.some(binding => binding.binding === 'SHARES' && binding.id === '907668f59e2b401b96ac15bf2c09437e') && config.d1_databases?.some(binding => binding.binding === 'SHARE_BUDGETS' && binding.database_id === '0c23bce1-e55b-44c7-bd97-e4ca0f233802'), 'preserve the existing share namespace and signing/budget database.');
}

export function validateCleanMain(branch, status) {
  requireValue(branch === 'main', `current branch is “${branch || 'detached HEAD'}”, not “main”.`);
  requireValue(!status, 'the main worktree has uncommitted changes.');
}

export function validateMatchingMain(head, remoteMain) {
  requireValue(head && remoteMain && head === remoteMain, 'local main does not exactly match origin/main.');
}

async function deploy() {
  const readGit = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });
  validateCleanMain(readGit('branch', '--show-current'), readGit('status', '--porcelain'));
  // Wrangler's parser handles JSONC comments/URLs and schema validation without another dependency.
  const { unstable_readConfig } = await import('wrangler');
  const config = unstable_readConfig({ config: join(root, configName) }, { preserveOriginalMain: true });
  validateProductProductionConfig(config);
  run('git', ['fetch', 'origin', 'main']);
  const head = readGit('rev-parse', 'HEAD');
  validateMatchingMain(head, readGit('rev-parse', 'origin/main'));
  const wrangler = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  const secrets = JSON.parse(execFileSync(wrangler, ['secret', 'list', '--config', configName, '--format', 'json'], { cwd: root, encoding: 'utf8' }));
  const names = new Set(secrets.map(secret => secret.name));
  requireValue(requiredSecrets.every(name => names.has(name)), `configure production Worker secrets first: ${requiredSecrets.filter(name => !names.has(name)).join(', ')}.`);
  console.log(`Deploying clean main ${head.slice(0, 7)} to the production CarouselBot Worker…`);
  run('npm', ['run', 'build']);
  run(wrangler, ['deploy', '--config', configName]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await deploy(); }
  catch (error) { console.error(`Production product deploy blocked: ${error.message}`); process.exitCode = 1; }
}
