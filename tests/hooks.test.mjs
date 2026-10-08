import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadYaml } from '../scripts/harness/lib.mjs';
import { ROOT, wf, inputDefaults } from './helpers.mjs';

const dir = path.join(ROOT, 'profiles/starter/hooks');
const toml = readFileSync(path.join(dir, '.gitleaks.toml'), 'utf8');

/** Minimal reader for the parts of .gitleaks.toml we rely on (no TOML parser in Node built-ins). */
function rules(text) {
  return text.split('[[rules]]').slice(1).map((block) => {
    const id = /^id = "([^"]+)"/m.exec(block)[1];
    const raw = /^regex = '''(.*)'''$/m.exec(block)[1];
    const ci = raw.startsWith('(?i)');
    return { id, re: new RegExp(ci ? raw.slice(4) : raw, ci ? 'i' : '') };
  });
}
// Build fake secrets at runtime so this file itself never contains one.
const fake = (...parts) => parts.join('');
const jwt = fake('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJyb2xlIjoic2VydmljZV9yb2xlIn0', '.', 'a'.repeat(43));

test('lefthook.yml: pre-commit scans staged changes, pre-push scans pushed commits, both with the org config', () => {
  const cfg = loadYaml(path.join(dir, 'lefthook.yml'));
  const pre = cfg['pre-commit'].commands.gitleaks.run;
  assert.match(pre, /gitleaks git --pre-commit --staged/);
  assert.match(pre, /--config \.gitleaks\.toml/);
  const push = cfg['pre-push'].commands.gitleaks.run;
  assert.match(push, /--log-opts="\$range"/);
  assert.match(push, /--config \.gitleaks\.toml/);
});

test('.gitleaks.toml: keeps default rules and org rules catch fake secrets without flagging placeholders', () => {
  assert.match(toml, /\[extend\]\s*\nuseDefault = true/);
  const byId = Object.fromEntries(rules(toml).map((r) => [r.id, r.re]));
  const hits = {
    'supabase-secret-key': [fake('const k = "sb_', 'secret_', 'AbCdEfGhIjKlMnOpQrStUvWx12"')],
    'supabase-service-role-jwt': [`SUPABASE_SERVICE_ROLE_KEY=${jwt}`, `serviceRoleKey: "${jwt}"`.replace('serviceRoleKey', 'service_role_key')],
    'rails-secret-key-base': [`secret_key_base: ${'ab12'.repeat(32)}`],
    'rails-master-key': [`RAILS_MASTER_KEY=${'0f'.repeat(16)}`],
  };
  const misses = {
    'supabase-secret-key': ['const k = process.env.SUPABASE_SECRET_KEY;'],
    'supabase-service-role-jwt': ['SUPABASE_SERVICE_ROLE_KEY=', 'SUPABASE_SERVICE_ROLE_KEY=your-service-role-key'],
    'rails-secret-key-base': ['secret_key_base: <%= ENV["SECRET_KEY_BASE"] %>'],
    'rails-master-key': ['RAILS_MASTER_KEY=changeme'],
  };
  for (const [id, lines] of Object.entries(hits)) for (const l of lines) assert.ok(byId[id].test(l), `${id} should flag: ${l.slice(0, 30)}…`);
  for (const [id, lines] of Object.entries(misses)) for (const l of lines) assert.ok(!byId[id].test(l), `${id} should not flag: ${l}`);
});

test('.gitleaks.toml allowlist: sample env files only, same pattern as the CI env-file allowlist', () => {
  const raw = /^paths = \['''(.*)'''\]$/m.exec(toml)[1];
  const re = new RegExp(raw);
  for (const f of ['.env.example', 'jfoodhub/.env.staging.example', 'web/.env.local.sample', '.env.template']) assert.ok(re.test(f), f);
  for (const f of ['.env', '.env.local', 'jfoodhub/.env.staging', '.env.example.local', 'src/example.ts']) assert.ok(!re.test(f), f);
  const ci = inputDefaults(wf('security.yml')).env_file_allowlist;
  assert.ok(raw.endsWith(ci), 'CI allowlist and hook allowlist should accept the same sample files');
});
