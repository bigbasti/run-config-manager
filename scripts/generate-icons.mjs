#!/usr/bin/env node
// Regenerates media/icons/*.svg from the simple-icons npm package. Each icon
// becomes a single-path SVG filled with the brand's canonical hex color.
// VS Code's TreeItem renders at 16×16, so we keep viewBox="0 0 24 24"
// (simple-icons native size) and let the host scale.
//
// Run with: node scripts/generate-icons.mjs
// (Usually invoked once when adding a new runtime type; generated files are
// checked in so end users don't need simple-icons at runtime.)

import * as si from 'simple-icons';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEDIA_ICONS = join(__dirname, '..', 'media', 'icons');
mkdirSync(MEDIA_ICONS, { recursive: true });

// Our filename → simple-icons slug map. Order matters for humans reading
// the media/icons/ dir listing; we keep the same order as RunConfigType.
// Brands with very dark or very light official colors are rendered with a
// theme-appropriate fill — Angular/Next.js/Java are black on their site but
// need a bright variant to stay visible on VS Code's dark theme. iconForConfig
// then returns a {light, dark} pair for those brands.
const ICONS = [
  // Runtime types
  ['spring-boot', 'siSpringboot'],
  ['tomcat',      'siApachetomcat'],
  ['quarkus',     'siQuarkus'],
  ['java',        'siOpenjdk'],
  ['maven',       'siApachemaven'],
  ['gradle',      'siGradle'],
  // npm family (detected sub-types)
  ['npm',         'siNpm'],
  ['node',        'siNodedotjs'],
  ['angular',     'siAngular'],
  ['react',       'siReact'],
  ['vue',         'siVuedotjs'],
  ['svelte',      'siSvelte'],
  ['vite',        'siVite'],
  ['nextjs',      'siNextdotjs'],
  // Go runtime
  ['go',          'siGo'],
  // Custom Command (shell-prompt glyph — recognizable across platforms).
  ['bash',        'siGnubash'],
  // Docker — canonical mid-blue reads on both themes.
  ['docker',      'siDocker'],
];

// All icons use the same neutral gray fills regardless of the brand's
// canonical color. This keeps the tree rows monochrome so VS Code's own
// state colors (green play = running, red = failed, yellow = rebuilding)
// read clearly without competing with brand hues.
//
// Two neutral values, one per theme:
//   dark  (#CCCCCC) — visible against VS Code's dark backgrounds.
//   light (#3C3C3C) — visible against VS Code's light backgrounds.
//
// The `-light` sibling file is always written so `brandIconUri` can return
// a proper {light, dark} pair. VS Code picks the right variant automatically.
function fillFor(_name, _hex) {
  return { dark: 'CCCCCC', light: '3C3C3C' };
}

let written = 0;
for (const [fileName, slug] of ICONS) {
  const icon = si[slug];
  if (!icon) {
    console.error(`simple-icons slug ${slug} not found — skipping ${fileName}`);
    process.exitCode = 1;
    continue;
  }
  const { light, dark } = fillFor(fileName, icon.hex);
  const tpl = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <title>${icon.title}</title>
  <path fill="#${fill}" d="${icon.path}"/>
</svg>
`;
  // Always write both the dark and light variants so iconForConfig can return
  // a proper {light, dark} Uri pair. VS Code picks the right file per theme.
  writeFileSync(join(MEDIA_ICONS, `${fileName}.svg`), tpl(dark));
  writeFileSync(join(MEDIA_ICONS, `${fileName}-light.svg`), tpl(light));
  written += 2;
  console.log(`✓ ${fileName}.svg + ${fileName}-light.svg  (${icon.title}  brand: #${icon.hex})`);

}

console.log(`\nWrote ${written} icon file(s) to media/icons/.`);
