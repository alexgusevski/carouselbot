import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("production deploys only verified main with narrowly scoped Cloudflare credentials", () => {
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(workflow, /deploy-production:[\s\S]*needs: test/);
  assert.match(workflow, /if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment:\n\s+name: production/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(
    workflow,
    /\.\/node_modules\/\.bin\/wrangler pages deploy dist --project-name slides-editor --branch main/,
  );
  assert.match(workflow, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
});
