// Starter dependency-cruiser. Harness dùng file này khi repo chưa có .dependency-cruiser.*
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Vòng import làm khó test, khó tách module và hay gây lỗi undefined lúc khởi tạo.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-dev-deps-in-prod-code',
      severity: 'error',
      comment: 'Code chạy thật không được import devDependencies (sẽ thiếu khi build production).',
      from: { path: '^(src|app|lib|components|pages|server|hooks|features)/', pathNot: '\\.(test|spec|stories)\\.[jt]sx?$' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment: 'Import tới module không tồn tại / chưa khai báo trong package.json.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-import-test-code',
      severity: 'error',
      comment: 'Code chạy thật không import file test.',
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
