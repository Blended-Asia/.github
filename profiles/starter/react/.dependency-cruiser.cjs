// Starter dependency-cruiser config. The harness uses this file when the repo has no .dependency-cruiser.* of its own
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Import cycles make testing and splitting modules harder and often cause undefined errors at initialization.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-dev-deps-in-prod-code',
      severity: 'error',
      comment: 'Production code must not import devDependencies (they are missing in production builds).',
      from: { path: '^(src|app|lib|components|pages|server|hooks|features)/', pathNot: '\\.(test|spec|stories)\\.[jt]sx?$' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment: 'Import of a module that does not exist / is not declared in package.json.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-import-test-code',
      severity: 'error',
      comment: 'Production code must not import test files.',
      from: { pathNot: '\\.(test|spec)\\.[jt]sx?$' },
      to: { path: '\\.(test|spec)\\.[jt]sx?$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(\\.next|dist|build|coverage|node_modules)/' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'],
    },
  },
};
