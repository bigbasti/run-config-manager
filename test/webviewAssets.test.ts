import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadWebviewAssets } from '../src/ui/webviewAssets';

function makeExt(js?: string, css?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-wva-'));
  const dir = path.join(root, 'media', 'webview', 'assets');
  fs.mkdirSync(dir, { recursive: true });
  if (js !== undefined) fs.writeFileSync(path.join(dir, 'main.js'), js);
  if (css !== undefined) fs.writeFileSync(path.join(dir, 'main.css'), css);
  return root;
}

describe('loadWebviewAssets', () => {
  it('reads js and css from media/webview/assets', () => {
    const root = makeExt('console.log(1);', 'body{color:red}');
    expect(loadWebviewAssets(root)).toEqual({ js: 'console.log(1);', css: 'body{color:red}' });
  });

  it('escapes closing script/style tags so inlined content cannot break out', () => {
    const root = makeExt('a("</script>");b("</SCRIPT>")', '.x{content:"</style>"}');
    const a = loadWebviewAssets(root);
    expect(a.js).toBe('a("<\\/script>");b("<\\/script>")');
    expect(a.css).toBe('.x{content:"<\\/style>"}');
  });

  it('strips the sourceMappingURL comment', () => {
    const root = makeExt('run();\n//# sourceMappingURL=main.js.map', '');
    expect(loadWebviewAssets(root).js).toBe('run();\n');
  });

  it('returns empty strings when assets are missing', () => {
    const root = makeExt();
    expect(loadWebviewAssets(root)).toEqual({ js: '', css: '' });
  });

  it('caches per extension root and reloads for a different root', () => {
    const root = makeExt('v1', '');
    expect(loadWebviewAssets(root).js).toBe('v1');
    fs.writeFileSync(path.join(root, 'media', 'webview', 'assets', 'main.js'), 'v2');
    expect(loadWebviewAssets(root).js).toBe('v1');
    const other = makeExt('other', '');
    expect(loadWebviewAssets(other).js).toBe('other');
  });
});
