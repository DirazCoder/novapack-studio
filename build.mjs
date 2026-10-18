import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const staging = path.join(root, '.build-staging');
const dist = path.join(root, 'dist');

const allPlatforms = [
  { platform: 'win', arch: 'x64' },
  { platform: 'osx', arch: 'arm64' },
  { platform: 'linux', arch: 'x64' },
];
const platformFlags = new Map([
  ['--win', 'win'],
  ['--windows', 'win'],
  ['--mac', 'osx'],
  ['--macos', 'osx'],
  ['--linux', 'linux'],
]);
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run build -- [--win] [--mac] [--linux]');
  console.log('Builds all platforms by default. Pass one or more flags to build only those platforms.');
  process.exit(0);
}

const unknownArgs = args.filter((arg) => !platformFlags.has(arg));
if (unknownArgs.length) {
  console.error(`Unknown build option(s): ${unknownArgs.join(', ')}`);
  console.error('Run "npm run build -- --help" for usage.');
  process.exit(1);
}

const selectedPlatforms = new Set(args.map((arg) => platformFlags.get(arg)));
const platforms = selectedPlatforms.size
  ? allPlatforms.filter(({ platform }) => selectedPlatforms.has(platform))
  : allPlatforms;

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

for (const item of ['index.html', 'package.json', 'package-lock.json', 'LICENSE', 'assets', 'src']) {
  const source = path.join(root, item);
  if (fs.existsSync(source)) {
    fs.cpSync(source, path.join(staging, item), { recursive: true });
  }
}

execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev'], {
  cwd: staging,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const { default: nwbuild } = await import('nw-builder');

for (const target of platforms) {
  const iconName = target.platform === 'win' ? 'icon.ico'
    : target.platform === 'osx' ? 'icon.icns'
    : 'icon.png';
  const outDir = path.join(dist, `${target.platform}-${target.arch}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  await nwbuild({
    mode: 'build',
    srcDir: staging,
    glob: false,
    ...target,
    version: '0.114.0',
    flavor: 'normal',
    outDir,
    app: {
      name: 'NovaByte Studio',
      description: 'NovaByte Studio',
      icon: path.join(root, 'assets', iconName),
      LSApplicationCategoryType: 'public.app-category.developer-tools',
      NSHumanReadableCopyright: 'Copyright 2026 NovaByteOfficial',
    },
  });
}

console.log(`Builds complete for: ${platforms.map(({ platform, arch }) => `${platform}-${arch}`).join(', ')}`);
