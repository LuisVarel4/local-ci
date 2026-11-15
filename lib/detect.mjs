import fs from 'node:fs/promises';
import path from 'node:path';
import { readText, readJson, exists } from './util.mjs';

const isWin = process.platform === 'win32';
const TAG_ORDER = ['lint', 'types', 'test', 'format', 'build'];

/* ---------------------------------------------------------------- helpers */

/** Tags for a script/target name. Name-based so `build: "tsc && vite build"` is not mistaken for a type-check. */
export function classify(name, extra = '') {
  const s = `${name} ${extra}`.toLowerCase();
  const tags = [];
  if (/lint|eslint|oxlint|stylelint|biome|phpcs|pint|cs-fixer|rubocop|clippy|ruff|flake8|\bvet\b|golangci/.test(s)) tags.push('lint');
  if (/type|tsc\b|analy[sz]e|phpstan|psalm|mypy|pyright|\bstan\b|^check$|svelte-check/.test(s)) tags.push('types');
  if (/test|spec\b|vitest|jest|phpunit|pest\b|pytest|rspec/.test(s)) tags.push('test');
  if (/format|fmt|prettier|black/.test(s) && !tags.includes('lint')) tags.push('format');
  if (/build|compile/.test(s)) tags.push('build');
  if (/e2e|playwright|cypress/.test(s)) tags.push('e2e');
  if (/(^|[:_\- ])(dev|start|serve|watch|preview|storybook)([:_\- ]|$)|--watch/.test(s)) tags.push('long-running');
  return tags;
}

function recommendedByName(name, tags) {
  const n = name.toLowerCase();
  if (tags.includes('long-running') || tags.includes('e2e')) return false;
  if (/fix|coverage|update|debug|(^|[:_-])ui($|[:_-])|install|clean|release|deploy|publish|snapshot|watch/.test(n)) return false;
  if (tags.includes('lint') || tags.includes('types') || tags.includes('test')) return true;
  return tags.includes('format') && /check|verify/.test(n);
}

const item = (label, command, o = {}) => ({
  label,
  command,
  tags: o.tags ?? classify(label),
  recommended: !!o.recommended,
  detail: o.detail || '',
});

function group(id, tech, title, source, items, extra = {}) {
  const seen = new Set();
  const uniq = items.filter((i) => (seen.has(i.command) ? false : seen.add(i.command)));
  return uniq.length ? { id, tech, title, source, items: uniq, ...extra } : null;
}

async function findUp(dir, stopAt, names) {
  let cur = dir;
  for (let i = 0; i < 6; i++) {
    for (const n of names) if (await exists(path.join(cur, n))) return { dir: cur, name: n };
    if (stopAt && path.resolve(cur) === path.resolve(stopAt)) break;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

/* ------------------------------------------------------------------ Node */

const NODE_TOOLS = [
  { dep: 'oxlint', label: 'oxlint', args: 'oxlint .', tags: ['lint'] },
  { dep: 'eslint', label: 'eslint', args: 'eslint .', tags: ['lint'] },
  { dep: '@biomejs/biome', label: 'biome check', args: 'biome check .', tags: ['lint', 'format'] },
  { dep: 'vue-tsc', label: 'vue-tsc', args: 'vue-tsc --noEmit', tags: ['types'], exclusive: true },
  { dep: 'svelte-check', label: 'svelte-check', args: 'svelte-check', tags: ['types'], exclusive: true },
  { dep: 'typescript', label: 'tsc --noEmit', args: 'tsc --noEmit', tags: ['types'], exclusive: true },
  { dep: 'vitest', label: 'vitest run', args: 'vitest run', tags: ['test'] },
  { dep: 'jest', label: 'jest', args: 'jest --ci', tags: ['test'] },
  { dep: 'prettier', label: 'prettier --check', args: 'prettier --check .', tags: ['format'], noRec: true },
  { dep: 'stylelint', label: 'stylelint', args: 'stylelint "**/*.{css,scss,vue}"', tags: ['lint'], noRec: true },
  { dep: '@playwright/test', label: 'playwright test', args: 'playwright test', tags: ['test', 'e2e'], noRec: true },
  { dep: 'cypress', label: 'cypress run', args: 'cypress run', tags: ['test', 'e2e'], noRec: true },
];

async function detectNode(dir, gitRoot) {
  const pkg = await readJson(path.join(dir, 'package.json'));
  if (!pkg) return [];
  let pm = 'npm';
  if (typeof pkg.packageManager === 'string') pm = pkg.packageManager.split('@')[0];
  else {
    const lock = await findUp(dir, gitRoot, ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json']);
    pm = { 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'bun.lockb': 'bun', 'bun.lock': 'bun' }[lock?.name] || 'npm';
  }
  const runCmd = (n) => (pm === 'yarn' ? `yarn ${n}` : `${pm} run ${n}`);
  const execCmd = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }[pm] || 'npx';

  const scripts = pkg.scripts || {};
  const names = Object.keys(scripts);
  const scriptItems = [];
  for (const n of names) {
    const body = String(scripts[n]);
    if (/^(pre|post)/.test(n) && names.includes(n.replace(/^(pre|post)/, ''))) continue;
    if (/^(prepare|prepublish|prepublishOnly|preinstall|install|postinstall|prepack|postpack)$/.test(n)) continue;
    if (/no test specified/.test(body)) continue;
    const tags = classify(n);
    let rec = recommendedByName(n, tags);
    if (n.includes(':') && names.includes(n.split(':')[0])) rec = false; // prefer `lint` over `lint:js`
    scriptItems.push(item(n, runCmd(n), { tags: tags.length ? tags : classify('', body).filter((t) => t !== 'long-running'), recommended: rec, detail: body }));
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const covered = new Set(scriptItems.filter((i) => i.recommended).flatMap((i) => i.tags));
  const toolItems = [];
  for (const t of NODE_TOOLS) {
    if (!deps[t.dep]) continue;
    const rec = !t.noRec && !t.tags.some((x) => covered.has(x));
    if (rec && t.exclusive) t.tags.forEach((x) => covered.add(x));
    toolItems.push(item(t.label, `${execCmd} ${t.args}`, { tags: t.tags, recommended: rec, detail: `${t.dep} ${deps[t.dep]}` }));
  }

  return [
    group('node-scripts', 'Node.js', 'package.json scripts', 'package.json', scriptItems, { meta: pm }),
    group('node-tools', 'Node.js', `Installed tools (${execCmd})`, 'package.json', toolItems, { meta: pm }),
  ];
}

/* ------------------------------------------------------------------- PHP */

const PHP_TOOLS = [
  { dep: ['phpunit/phpunit'], label: 'phpunit', cmd: 'php vendor/bin/phpunit', tags: ['test'] },
  { dep: ['pestphp/pest'], label: 'pest', cmd: 'php vendor/bin/pest', tags: ['test'] },
  { dep: ['phpstan/phpstan', 'larastan/larastan', 'nunomaduro/larastan'], label: 'phpstan', cmd: 'php vendor/bin/phpstan analyse --no-progress --memory-limit=1G', tags: ['types'] },
  { dep: ['vimeo/psalm'], label: 'psalm', cmd: 'php vendor/bin/psalm --no-progress', tags: ['types'] },
  { dep: ['laravel/pint'], label: 'pint --test', cmd: 'php vendor/bin/pint --test', tags: ['lint'] },
  { dep: ['friendsofphp/php-cs-fixer'], label: 'php-cs-fixer (dry run)', cmd: 'php vendor/bin/php-cs-fixer fix --dry-run --diff', tags: ['lint'] },
  { dep: ['squizlabs/php_codesniffer'], label: 'phpcs', cmd: 'php vendor/bin/phpcs', tags: ['lint'] },
  { dep: ['rector/rector'], label: 'rector (dry run)', cmd: 'php vendor/bin/rector process --dry-run', tags: ['lint'], noRec: true },
];

async function detectPhp(dir) {
  const c = await readJson(path.join(dir, 'composer.json'));
  if (!c) return [];
  const scripts = c.scripts || {};
  const desc = c['scripts-descriptions'] || {};
  const names = Object.keys(scripts);
  const scriptItems = names
    .filter((n) => !/^(pre|post)-/.test(n))
    .map((n) => {
      const tags = classify(n);
      let rec = recommendedByName(n, tags);
      if (n.includes(':') && names.includes(n.split(':')[0])) rec = false;
      const body = Array.isArray(scripts[n]) ? scripts[n].join(' && ') : String(scripts[n]);
      return item(n, `composer run-script ${n}`, { tags, recommended: rec, detail: desc[n] || body });
    });

  const deps = { ...c.require, ...c['require-dev'] };
  const covered = new Set(scriptItems.filter((i) => i.recommended).flatMap((i) => i.tags));
  const toolItems = [];
  for (const t of PHP_TOOLS) {
    const dep = t.dep.find((d) => deps[d]);
    if (!dep) continue;
    toolItems.push(item(t.label, t.cmd, { tags: t.tags, recommended: !t.noRec && !t.tags.some((x) => covered.has(x)), detail: `${dep} ${deps[dep]}` }));
  }
  if (await exists(path.join(dir, 'artisan'))) {
    const rec = !covered.has('test') && !!deps['laravel/framework'];
    toolItems.unshift(item('artisan test', 'php artisan test', { tags: ['test'], recommended: rec, detail: 'Laravel test runner' }));
    if (rec) toolItems.forEach((i) => { if (/phpunit|pest/.test(i.label)) i.recommended = false; });
  }
  toolItems.push(item('composer validate', 'composer validate --strict', { tags: ['lint'], detail: 'Validate composer.json / lock' }));

  return [
    group('php-scripts', 'PHP', 'composer.json scripts', 'composer.json', scriptItems),
    group('php-tools', 'PHP', 'Installed tools (vendor/bin)', 'composer.json', toolItems),
  ];
}

/* ---------------------------------------------------------------- Python */

async function detectPython(dir) {
  const files = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'setup.cfg', 'setup.py', 'Pipfile', 'tox.ini'];
  const texts = {};
  for (const f of files) texts[f] = await readText(path.join(dir, f));
  if (!Object.values(texts).some((t) => t != null)) return [];
  const all = Object.values(texts).join('\n').toLowerCase();
  const has = (re, ...cfg) => re.test(all) || cfg.some((f) => texts[f] != null);
  const prefix = (await exists(path.join(dir, 'uv.lock')))
    ? 'uv run '
    : (await exists(path.join(dir, 'poetry.lock')))
      ? 'poetry run '
      : (await exists(path.join(dir, 'pdm.lock')))
        ? 'pdm run '
        : '';
  const ruffCfg = (await exists(path.join(dir, 'ruff.toml'))) || (await exists(path.join(dir, '.ruff.toml')));
  const items = [];
  if (/\bruff\b/.test(all) || ruffCfg) {
    items.push(item('ruff check', `${prefix}ruff check .`, { tags: ['lint'], recommended: true }));
    items.push(item('ruff format --check', `${prefix}ruff format --check .`, { tags: ['format'] }));
  }
  if (/\bblack\b/.test(all)) items.push(item('black --check', `${prefix}black --check .`, { tags: ['format'] }));
  if (/\bflake8\b/.test(all) || (await exists(path.join(dir, '.flake8')))) items.push(item('flake8', `${prefix}flake8`, { tags: ['lint'], recommended: !/\bruff\b/.test(all) }));
  if (/\bmypy\b/.test(all) || (await exists(path.join(dir, 'mypy.ini')))) items.push(item('mypy', `${prefix}mypy .`, { tags: ['types'], recommended: true }));
  if (/\bpyright\b/.test(all)) items.push(item('pyright', `${prefix}pyright`, { tags: ['types'] }));
  if (/\bpytest\b/.test(all) || (await exists(path.join(dir, 'pytest.ini'))) || (await exists(path.join(dir, 'tests')))) {
    items.push(item('pytest', `${prefix}pytest`, { tags: ['test'], recommended: true }));
  }
  if (has(/\btox\b/, 'tox.ini')) items.push(item('tox', 'tox', { tags: ['test'] }));
  if (await exists(path.join(dir, 'manage.py'))) items.push(item('django test', `${prefix}python manage.py test`, { tags: ['test'], recommended: !items.some((i) => i.label === 'pytest') }));
  return [group('python', 'Python', 'Python tooling', 'pyproject / requirements', items, { meta: prefix.trim() || 'pip' })];
}

/* ------------------------------------------------------ Go / Rust / .NET */

async function detectGo(dir) {
  if (!(await exists(path.join(dir, 'go.mod')))) return [];
  const items = [
    item('go build', 'go build ./...', { tags: ['build'] }),
    item('go vet', 'go vet ./...', { tags: ['lint'], recommended: true }),
    item('go test', 'go test ./...', { tags: ['test'], recommended: true }),
  ];
  for (const f of ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json']) {
    if (await exists(path.join(dir, f))) {
      items.push(item('golangci-lint', 'golangci-lint run', { tags: ['lint'], recommended: true }));
      break;
    }
  }
  return [group('go', 'Go', 'Go toolchain', 'go.mod', items)];
}

async function detectRust(dir) {
  if (!(await exists(path.join(dir, 'Cargo.toml')))) return [];
  return [
    group('rust', 'Rust', 'Cargo', 'Cargo.toml', [
      item('cargo check', 'cargo check --all-targets', { tags: ['types'] }),
      item('cargo clippy', 'cargo clippy --all-targets -- -D warnings', { tags: ['lint'], recommended: true }),
      item('cargo fmt --check', 'cargo fmt --all -- --check', { tags: ['format'], recommended: true }),
      item('cargo test', 'cargo test', { tags: ['test'], recommended: true }),
    ]),
  ];
}

async function detectDotnet(dir) {
  const entries = await fs.readdir(dir).catch(() => []);
  const proj = entries.find((f) => /\.(sln|slnx)$/i.test(f)) || entries.find((f) => /\.(csproj|fsproj|vbproj)$/i.test(f));
  if (!proj) return [];
  return [
    group('dotnet', '.NET', 'dotnet CLI', proj, [
      item('dotnet build', 'dotnet build --nologo', { tags: ['build'], recommended: true }),
      item('dotnet test', 'dotnet test --nologo', { tags: ['test'], recommended: true }),
      item('dotnet format', 'dotnet format --verify-no-changes', { tags: ['format'] }),
    ]),
  ];
}

/* ----------------------------------------------------- Java / Ruby / Deno */

async function detectJava(dir) {
  const out = [];
  if (await exists(path.join(dir, 'pom.xml'))) {
    const mvn = (await exists(path.join(dir, 'mvnw'))) ? (isWin ? 'mvnw.cmd' : './mvnw') : 'mvn';
    out.push(group('maven', 'Java', 'Maven', 'pom.xml', [
      item('mvn verify', `${mvn} -B verify`, { tags: ['test', 'build'], recommended: true }),
      item('mvn test', `${mvn} -B test`, { tags: ['test'] }),
      item('mvn compile', `${mvn} -B -q compile`, { tags: ['build'] }),
    ]));
  }
  const gradleFile = (await exists(path.join(dir, 'build.gradle')))
    ? 'build.gradle'
    : (await exists(path.join(dir, 'build.gradle.kts'))) ? 'build.gradle.kts' : null;
  if (gradleFile) {
    const g = (await exists(path.join(dir, 'gradlew'))) ? (isWin ? 'gradlew.bat' : './gradlew') : 'gradle';
    out.push(group('gradle', 'Java', 'Gradle', gradleFile, [
      item('gradle check', `${g} check`, { tags: ['test', 'lint'], recommended: true }),
      item('gradle test', `${g} test`, { tags: ['test'] }),
      item('gradle build', `${g} build`, { tags: ['build'] }),
    ]));
  }
  return out;
}

async function detectRuby(dir) {
  if (!(await exists(path.join(dir, 'Gemfile')))) return [];
  const lock = ((await readText(path.join(dir, 'Gemfile.lock'))) || (await readText(path.join(dir, 'Gemfile'))) || '').toLowerCase();
  const items = [];
  if (/rubocop/.test(lock)) items.push(item('rubocop', 'bundle exec rubocop', { tags: ['lint'], recommended: true }));
  if (/rspec/.test(lock)) items.push(item('rspec', 'bundle exec rspec', { tags: ['test'], recommended: true }));
  if (/\brails\b/.test(lock)) items.push(item('rails test', 'bundle exec rails test', { tags: ['test'], recommended: !/rspec/.test(lock) }));
  if (await exists(path.join(dir, 'Rakefile'))) items.push(item('rake test', 'bundle exec rake test', { tags: ['test'] }));
  return [group('ruby', 'Ruby', 'Bundler', 'Gemfile', items)];
}

async function detectDeno(dir) {
  let file = null;
  let cfg = null;
  for (const f of ['deno.json', 'deno.jsonc']) {
    const t = await readText(path.join(dir, f));
    if (t != null) {
      file = f;
      try {
        cfg = JSON.parse(t.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
      } catch {
        cfg = {};
      }
      break;
    }
  }
  if (!file) return [];
  const tasks = Object.keys(cfg?.tasks || {}).map((n) => {
    const tags = classify(n);
    return item(n, `deno task ${n}`, { tags, recommended: recommendedByName(n, tags), detail: String(cfg.tasks[n]?.command ?? cfg.tasks[n]) });
  });
  const covered = new Set(tasks.filter((i) => i.recommended).flatMap((i) => i.tags));
  return [
    group('deno-tasks', 'Deno', 'deno tasks', file, tasks),
    group('deno-tools', 'Deno', 'Deno built-ins', file, [
      item('deno lint', 'deno lint', { tags: ['lint'], recommended: !covered.has('lint') }),
      item('deno check', 'deno check .', { tags: ['types'], recommended: !covered.has('types') }),
      item('deno fmt --check', 'deno fmt --check', { tags: ['format'] }),
      item('deno test', 'deno test -A', { tags: ['test'], recommended: !covered.has('test') }),
    ]),
  ];
}

/* ------------------------------------------------------- task runners */

async function detectTaskRunners(dir) {
  const out = [];
  for (const f of ['Makefile', 'makefile', 'GNUmakefile']) {
    const t = await readText(path.join(dir, f));
    if (t == null) continue;
    const names = [...t.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm)].map((m) => m[1]).filter((n) => !n.includes('%'));
    out.push(group('make', 'Make', 'Make targets', f, [...new Set(names)].map((n) => item(n, `make ${n}`))));
    break;
  }
  for (const f of ['justfile', 'Justfile', '.justfile']) {
    const t = await readText(path.join(dir, f));
    if (t == null) continue;
    const names = [...t.matchAll(/^@?([A-Za-z_][\w-]*)(?:\s+[^:=\n]*)?:(?!=)/gm)]
      .map((m) => m[1])
      .filter((n) => !['set', 'alias', 'export', 'import', 'mod'].includes(n));
    out.push(group('just', 'just', 'just recipes', f, [...new Set(names)].map((n) => item(n, `just ${n}`))));
    break;
  }
  for (const f of ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml']) {
    const t = await readText(path.join(dir, f));
    if (t == null) continue;
    const lines = t.split(/\r?\n/);
    const start = lines.findIndex((l) => /^tasks:\s*$/.test(l));
    const names = [];
    if (start >= 0) {
      let indent = null;
      for (const l of lines.slice(start + 1)) {
        if (/^\S/.test(l)) break;
        const m = l.match(/^(\s+)([\w:.-]+):\s*(#.*)?$/);
        if (!m) continue;
        indent ??= m[1].length;
        if (m[1].length === indent) names.push(m[2]);
      }
    }
    out.push(group('task', 'Task', 'Taskfile tasks', f, names.map((n) => item(n, `task ${n}`))));
    break;
  }
  return out;
}

/* ---------------------------------------------------- hooks & remote CI */

const SKIP_CI_CMD = /\b(npm (ci|install)|pnpm (i|install)|yarn( install)?$|composer install|pip install|bundle install|apt(-get)?|brew|choco|echo|cd|mkdir|cp|mv|rm|export|curl|wget|docker (login|push|build)|deploy|publish|upload|setup|cache|corepack)\b|\$\{\{|^\s*(if|then|fi|for|do|done|else)\b/;

function ciCommands(text) {
  const cmds = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-?\s*run:\s*(.*)$/);
    if (m) {
      const v = m[2].trim();
      if (v && !/^[|>]/.test(v)) cmds.push(v.replace(/^["']|["']$/g, ''));
      else if (/^[|>]/.test(v)) {
        const block = [];
        const base = m[1].length;
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j];
          if (!l.trim()) continue;
          if (l.search(/\S/) <= base) break;
          block.push(l.trim());
        }
        if (block.length && block.length <= 4) cmds.push(...block);
      }
      continue;
    }
    // GitLab / Bitbucket: `script:` lists
    const s = lines[i].match(/^(\s*)-?\s*script:\s*$/);
    if (s) {
      const base = s[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim()) continue;
        if (l.search(/\S/) <= base && !/^\s*-/.test(l)) break;
        const li = l.match(/^\s*-\s+(.+)$/);
        if (!li) break;
        cmds.push(li[1].trim().replace(/^["']|["']$/g, ''));
      }
    }
  }
  return cmds.filter((c) => c && !c.startsWith('#') && !SKIP_CI_CMD.test(c));
}

const shortLabel = (cmd) => (cmd.length > 38 ? cmd.slice(0, 36) + '…' : cmd);

async function detectHooksAndCi(dir, gitRoot, hooksDir) {
  const root = gitRoot || dir;
  const out = [];

  const husky = await readText(path.join(root, '.husky', 'pre-push'));
  if (husky) {
    const cmds = husky
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('.') && !/husky\.sh|^exit\b|^set\b/.test(l));
    out.push(group('husky', 'Hooks', 'husky pre-push', '.husky/pre-push', cmds.map((c) => item(shortLabel(c), c, { recommended: false }))));
  }

  for (const f of ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml']) {
    const t = await readText(path.join(root, f));
    if (!t) continue;
    const sec = t.match(/^pre-push:\s*\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m);
    const cmds = sec ? [...sec[1].matchAll(/run:\s*(.+)$/gm)].map((m) => m[1].trim().replace(/^["']|["']$/g, '')) : [];
    out.push(group('lefthook', 'Hooks', 'lefthook pre-push', f, cmds.map((c) => item(shortLabel(c), c))));
    break;
  }

  if (hooksDir) {
    const legacy = await readJson(path.join(hooksDir, 'pre-push-ci.json'));
    if (legacy?.processes?.length) {
      out.push(group('legacy', 'Hooks', 'pre-push-ci.json', '.git/hooks/pre-push-ci.json',
        legacy.processes.filter((p) => p.command).map((p) => item(p.label || p.id || shortLabel(p.command), p.command, { recommended: false }))));
    }
  }

  const wfDir = path.join(root, '.github', 'workflows');
  const wfs = (await fs.readdir(wfDir).catch(() => [])).filter((f) => /\.ya?ml$/.test(f));
  const gh = [];
  for (const f of wfs) {
    const t = await readText(path.join(wfDir, f));
    if (t) gh.push(...ciCommands(t).map((c) => item(shortLabel(c), c, { detail: `.github/workflows/${f}` })));
  }
  out.push(group('github', 'Remote CI', 'GitHub Actions steps', '.github/workflows', gh));

  for (const f of ['.gitlab-ci.yml', 'bitbucket-pipelines.yml']) {
    const t = await readText(path.join(root, f));
    if (t) out.push(group(f, 'Remote CI', f.startsWith('.gitlab') ? 'GitLab CI scripts' : 'Bitbucket Pipelines', f, ciCommands(t).map((c) => item(shortLabel(c), c))));
  }
  return out.map((g) => g && { ...g, secondary: true });
}

/* ------------------------------------------------------------------ API */

export async function detectSuggestions(repo) {
  const { dir, gitRoot, hooksDir } = repo;
  const parts = await Promise.all([
    detectNode(dir, gitRoot),
    detectPhp(dir),
    detectPython(dir),
    detectGo(dir),
    detectRust(dir),
    detectDotnet(dir),
    detectJava(dir),
    detectRuby(dir),
    detectDeno(dir),
    detectTaskRunners(dir),
    detectHooksAndCi(dir, gitRoot, hooksDir),
  ]);
  const groups = parts.flat().filter(Boolean);
  for (const g of groups) for (const i of g.items) i.tags = (i.tags || []).filter((t, n, a) => a.indexOf(t) === n);
  const techs = [...new Set(groups.filter((g) => !g.secondary).map((g) => g.tech))];
  return { groups, techs };
}

/** Default command plan when a folder has no preset: recommended items, ordered lint → types → test. */
export function recommendedFrom(det) {
  const picked = [];
  const seen = new Set();
  for (const g of det.groups) {
    if (g.secondary) continue;
    for (const i of g.items) {
      if (!i.recommended || seen.has(i.command)) continue;
      seen.add(i.command);
      picked.push({ label: i.label, command: i.command, tech: g.tech, rank: Math.min(...i.tags.map((t) => (TAG_ORDER.indexOf(t) + 1) || 9), 9) });
    }
  }
  const dupLabels = new Set(picked.map((p) => p.label).filter((l, i, a) => a.indexOf(l) !== i));
  return picked
    .sort((a, b) => a.rank - b.rank)
    .map((p) => ({ label: dupLabels.has(p.label) ? `${p.tech.toLowerCase().replace(/\.js$/, '')} ${p.label}` : p.label, command: p.command, enabled: true }));
}
