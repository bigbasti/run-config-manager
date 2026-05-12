import type { HistogramRow } from './AgentMessage';

// A node in the package-prefix tree the table renders. Internal nodes
// have children + cumulative counts; leaves carry a single class.
export interface HistogramNode {
  name: string;          // segment of the dotted name, or full leaf name
  totalInstances: number;
  totalBytes: number;
  children: HistogramNode[];
  // Only set on leaves — the original row.
  row?: HistogramRow;
}

// Groups the histogram by package prefix. JVM array types (`[B`, `[C`,
// `[Ljava.lang.String;`) are parked under a synthetic `[arrays]` group
// to keep the top-level list readable. Unqualified class names land
// under `[default]`.
//
// Sort: top-level + every sibling list is sorted by totalBytes desc.
// The webview's table can re-sort by another column without rebuilding.
export function groupByPackage(rows: HistogramRow[]): HistogramNode[] {
  const root = makeNode('__root__');
  for (const row of rows) {
    const segments = classNameToSegments(row.className);
    let node = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      let child = node.children.find(c => c.name === seg);
      if (!child) {
        child = makeNode(seg);
        if (isLast) child.row = row;
        node.children.push(child);
      }
      child.totalInstances += row.instances;
      child.totalBytes += row.bytes;
      node = child;
    }
  }
  // Recursive sort by totalBytes desc.
  sortRec(root);
  return root.children;
}

function makeNode(name: string): HistogramNode {
  return { name, totalInstances: 0, totalBytes: 0, children: [] };
}

function sortRec(node: HistogramNode): void {
  node.children.sort((a, b) => b.totalBytes - a.totalBytes);
  for (const c of node.children) sortRec(c);
}

// Turns a JVM internal class name into a segment list:
//   'java.util.HashMap$Node' → ['java', 'util', 'HashMap$Node']
//   'AnonymousLambda'        → ['[default]', 'AnonymousLambda']
//   '[B'                     → ['[arrays]', 'byte']
//   '[Ljava.lang.String;'    → ['[arrays]', 'String[]']
function classNameToSegments(className: string): string[] {
  if (className.startsWith('[')) {
    return ['[arrays]', prettyArrayName(className)];
  }
  if (!className.includes('.')) {
    return ['[default]', className];
  }
  return className.split('.');
}

function prettyArrayName(className: string): string {
  // Crude but readable: '[Ljava.lang.String;' → 'String[]', '[B' → 'byte[]'.
  let depth = 0;
  let name = className;
  while (name.startsWith('[')) { depth++; name = name.slice(1); }
  let base: string;
  switch (name) {
    case 'B': base = 'byte'; break;
    case 'C': base = 'char'; break;
    case 'D': base = 'double'; break;
    case 'F': base = 'float'; break;
    case 'I': base = 'int'; break;
    case 'J': base = 'long'; break;
    case 'S': base = 'short'; break;
    case 'Z': base = 'boolean'; break;
    default:
      if (name.startsWith('L') && name.endsWith(';')) {
        const cls = name.slice(1, -1);
        const lastDot = cls.lastIndexOf('.');
        base = lastDot >= 0 ? cls.slice(lastDot + 1) : cls;
      } else {
        base = name;
      }
  }
  return base + '[]'.repeat(depth);
}
