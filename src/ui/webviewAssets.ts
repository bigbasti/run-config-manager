import * as fs from 'fs';
import * as path from 'path';

// Recent VS Code builds (1.141+, notably over Remote-WSL) fail to fetch
// <script src>/<link href> assets from the vscode-resource host, leaving the
// webview blank. We read the bundle from disk and inline it into the HTML.
export interface WebviewAssets {
  js: string;
  css: string;
}

let cache: { root: string; assets: WebviewAssets } | undefined;

export function loadWebviewAssets(extensionFsPath: string): WebviewAssets {
  if (cache && cache.root === extensionFsPath) return cache.assets;
  const dir = path.join(extensionFsPath, 'media', 'webview', 'assets');
  const read = (f: string) => {
    try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; }
  };
  const assets: WebviewAssets = {
    js: read('main.js').replace(/<\/script/gi, '<\\/script').replace(/\/\/# sourceMappingURL=.*$/m, ''),
    css: read('main.css').replace(/<\/style/gi, '<\\/style'),
  };
  cache = { root: extensionFsPath, assets };
  return assets;
}
