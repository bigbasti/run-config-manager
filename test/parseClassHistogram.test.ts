import { groupByPackage } from '../src/services/monitoring/parseClassHistogram';

describe('groupByPackage', () => {
  test('groups by top-level package and sums counts/bytes', () => {
    const rows = [
      { instances: 100, bytes: 1000, className: 'java.util.HashMap$Node' },
      { instances: 50,  bytes: 500,  className: 'java.util.ArrayList' },
      { instances: 25,  bytes: 250,  className: 'java.lang.String' },
      { instances: 10,  bytes: 100,  className: 'org.springframework.boot.Application' },
      { instances: 200, bytes: 2000, className: 'com.example.MyService' },
    ];
    const tree = groupByPackage(rows);
    // top-level groups
    const java = tree.find(n => n.name === 'java');
    expect(java).toBeDefined();
    expect(java!.totalInstances).toBe(175);
    expect(java!.totalBytes).toBe(1750);
    // sub-groups
    const javaUtil = java!.children.find(n => n.name === 'util');
    expect(javaUtil).toBeDefined();
    expect(javaUtil!.totalInstances).toBe(150);
  });

  test('keeps array types as a single leaf', () => {
    const rows = [
      { instances: 12, bytes: 10000, className: '[B' }, // byte[]
      { instances: 8,  bytes: 6000,  className: '[C' }, // char[]
    ];
    const tree = groupByPackage(rows);
    const arrays = tree.find(n => n.name === '[arrays]');
    expect(arrays).toBeDefined();
    expect(arrays!.children.length).toBe(2);
  });

  test('sorts groups by total bytes descending', () => {
    const rows = [
      { instances: 1, bytes: 10, className: 'a.A' },
      { instances: 1, bytes: 100, className: 'b.B' },
      { instances: 1, bytes: 50, className: 'c.C' },
    ];
    const tree = groupByPackage(rows);
    expect(tree.map(n => n.name)).toEqual(['b', 'c', 'a']);
  });

  test('handles unqualified class names (no dot)', () => {
    const rows = [
      { instances: 1, bytes: 100, className: 'AnonymousLambda' },
    ];
    const tree = groupByPackage(rows);
    const root = tree.find(n => n.name === '[default]');
    expect(root).toBeDefined();
    expect(root!.children[0].name).toBe('AnonymousLambda');
  });
});
