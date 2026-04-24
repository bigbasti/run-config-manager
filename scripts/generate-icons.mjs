#!/usr/bin/env node
// Regenerates media/icons/*.svg from the simple-icons npm package. Each icon
// becomes a single-path SVG filled with the brand's canonical hex color.
// VS Code's TreeItem renders at 16×16, so we keep viewBox="0 0 24 24"
// (simple-icons native size) and let the host scale.
//
// The Maven entry is an EXCEPTION — simple-icons only ships the
// feathers mark, which doesn't match the community-standard cursive-M
// logo. We override with the Apache Maven wordmark from
// @iconify-icons/logos (full-color gradient cursive M), cropped to just
// the M glyph so it reads at 16×16.
//
// Run with: node scripts/generate-icons.mjs
// (Usually invoked once when adding a new runtime type; generated files are
// checked in so end users don't need simple-icons at runtime.)

import * as si from 'simple-icons';
import mavenWordmark from '@iconify-icons/logos/maven.js';
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
  // Custom Command (shell-prompt glyph — recognizable across platforms).
  ['bash',        'siGnubash'],
];

// For brands whose canonical color doesn't read well on a dark VS Code
// theme (pure black, very low luminance), swap to a bright neutral. Keyed
// on our filename; pick-fill runs *after* we know the simple-icons hex.
function fillFor(name, hex) {
  // Very dark colors (luminance < 0.15 using the simple relative formula)
  // get swapped to a bright neutral so tree rows stay legible on dark
  // themes. The 'light' variant keeps the original hex since it reads fine
  // against VS Code's light theme.
  return {
    dark: needsLighten(hex) ? 'CCCCCC' : hex,
    light: hex,
  };
}

function needsLighten(hex) {
  // Fast luminance check — true RGB → YIQ. Anything dim enough to be a
  // problem on dark backgrounds gets flipped. Threshold picked empirically.
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const y = (r * 299 + g * 587 + b * 114) / 1000;
  return y < 40;
}

// Hand-authored / externally-sourced overrides for brands where the
// simple-icons mark reads poorly at 16px or doesn't match the
// community-standard visual. Keys are our internal filenames; value is
// a function returning the full <svg>…</svg> string (the generator
// writes it verbatim instead of wrapping with its single-path template).
const OVERRIDES = {
  // simple-icons ships only the "feathers" Maven mark. The wider
  // community associates Maven with the cursive-M wordmark — that lives
  // in @iconify-icons/logos's apache-maven icon. We use it but crop the
  // viewBox to just the M glyph so 16×16 tree rows stay legible (the
  // raw wordmark is 512×139, way too narrow for tree cells).
  maven: () => {
    const rawBody = mavenWordmark.default?.body ?? mavenWordmark.body;
    // Strip the big black <path fill="#000"> that draws the "Maven" text
    // — the gradient layers already draw the cursive M on their own.
    const mOnly = rawBody.replace(/<path fill="#000" d="M212\.12[^"]+"\/>/, '');
    // Eyeballed crop isolating the cursive M (translates are around
    // x=250, y=25 in the original 512×139 canvas).
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="245 0 150 140">
  <title>Apache Maven</title>
  ${mOnly}
</svg>
`;
  },
};

let written = 0;
for (const [fileName, slug] of ICONS) {
  const overrideFn = OVERRIDES[fileName];
  if (overrideFn) {
    writeFileSync(join(MEDIA_ICONS, `${fileName}.svg`), overrideFn());
    written++;
    console.log(`✓ ${fileName}.svg  (override: iconify logos wordmark, cropped)`);
    continue;
  }
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
  // Always write the base file (dark-theme variant) and, when dark !== light,
  // a -light sibling. iconForConfig builds {light, dark} Uri pairs when the
  // -light file exists.
  writeFileSync(join(MEDIA_ICONS, `${fileName}.svg`), tpl(dark));
  written++;
  if (light !== dark) {
    writeFileSync(join(MEDIA_ICONS, `${fileName}-light.svg`), tpl(light));
    written++;
    console.log(`✓ ${fileName}.svg  (dark #${dark})  + ${fileName}-light.svg  (light #${light})`);
  } else {
    console.log(`✓ ${fileName}.svg  (#${dark}  ${icon.title})`);
  }
}

console.log(`\nWrote ${written} icon file(s) to media/icons/.`);
