import {
  parsePyprojectDependencies,
  parseRequirementsTxt,
  parsePoetryDependencies,
  knownFrameworksFromPackages,
  parseImportStatements,
} from '../src/adapters/python/detectFrameworks';

describe('parsePyprojectDependencies (PEP 621)', () => {
  test('extracts dependencies array', () => {
    const toml = `
[project]
name = "x"
dependencies = [
  "django>=4.2",
  "requests",
  "fastapi>=0.100",
]
`;
    const out = parsePyprojectDependencies(toml);
    expect(out).toEqual(expect.arrayContaining(['django', 'requests', 'fastapi']));
  });
  test('returns [] when [project] section absent', () => {
    expect(parsePyprojectDependencies('# empty')).toEqual([]);
  });
  test('strips version specifiers and extras', () => {
    const toml = `[project]
dependencies = ["uvicorn[standard]>=0.27", "celery[redis]==5.3.0"]`;
    const out = parsePyprojectDependencies(toml);
    expect(out).toEqual(expect.arrayContaining(['uvicorn', 'celery']));
  });
});

describe('parsePoetryDependencies', () => {
  test('extracts [tool.poetry.dependencies] keys', () => {
    const toml = `
[tool.poetry.dependencies]
python = "^3.11"
flask = "^3.0"
gunicorn = "21.2.0"
`;
    const out = parsePoetryDependencies(toml);
    expect(out).toEqual(expect.arrayContaining(['flask', 'gunicorn']));
    expect(out).not.toContain('python'); // ignored
  });
});

describe('parseRequirementsTxt', () => {
  test('strips version pins, extras, comments, blank lines', () => {
    const text = `
django>=4.2.0  # web framework
fastapi[standard]==0.105.0
celery
# comment line
-r other.txt
`;
    expect(parseRequirementsTxt(text)).toEqual(
      expect.arrayContaining(['django', 'fastapi', 'celery']),
    );
  });
  test('handles pip URL hashes', () => {
    const text = `numpy==1.26.0 \\\n  --hash=sha256:abc`;
    expect(parseRequirementsTxt(text)).toEqual(['numpy']);
  });
});

describe('knownFrameworksFromPackages', () => {
  test('maps known package names to PythonFramework values', () => {
    expect(knownFrameworksFromPackages(['django', 'requests'])).toEqual(['django']);
    expect(knownFrameworksFromPackages(['fastapi', 'uvicorn'])).toEqual(
      expect.arrayContaining(['fastapi', 'uvicorn']),
    );
  });
  test('ignores unknown packages', () => {
    expect(knownFrameworksFromPackages(['numpy', 'pytz'])).toEqual([]);
  });
});

describe('parseImportStatements', () => {
  test('matches `from <fw> import …` at line start', () => {
    const src = `import os\nfrom flask import Flask\napp = Flask(__name__)\n`;
    expect(parseImportStatements(src)).toEqual(['flask']);
  });
  test('matches `import <fw>` and `import <fw>.sub`', () => {
    const src = `import django\nimport celery.schedules\n`;
    expect(parseImportStatements(src)).toEqual(expect.arrayContaining(['django', 'celery']));
  });
  test('handles indented imports inside if/try blocks (skipped — only top-level)', () => {
    // Indented imports are uncommon at module scope; the matcher requires
    // the import to be at line start (after trim). We DO trim, so indented
    // imports DO match in this implementation. Confirm that behaviour.
    const src = `try:\n    import fastapi\nexcept ImportError:\n    pass\n`;
    expect(parseImportStatements(src)).toEqual(['fastapi']);
  });
  test('returns [] when no known framework imports', () => {
    expect(parseImportStatements('import os\nimport sys\n')).toEqual([]);
    expect(parseImportStatements('')).toEqual([]);
  });
  test('dedupes when a framework appears in multiple imports', () => {
    const src = `import flask\nfrom flask import Blueprint\n`;
    expect(parseImportStatements(src)).toEqual(['flask']);
  });
});
