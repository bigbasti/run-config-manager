import { useEffect, useMemo, useRef, useState } from 'react';
import type { Inbound, Outbound, NodeVersionDto } from '../../src/shared/protocol';

type InstallerKind = 'nvm' | 'download';

// Modal dialog for downloading + installing a Node.js distribution.
// Single version select like Gradle — Node releases come from the
// nodejs.org/dist/index.json listing on the extension side. Each entry
// carries flags for `isLts`, `currentLts`, and `current` so the dialog
// can highlight the recommended pick (the most recent LTS) and the
// latest GA release distinctly.

type Phase = 'idle' | 'downloading' | 'verifying' | 'extracting' | 'installing' | 'complete' | 'error';

interface Props {
  versions: NodeVersionDto[];
  installRoot: string;
  // Which installer EditorPanel will route through. `'nvm'` when nvm.sh
  // was detected on a POSIX host; `'download'` (default) for the
  // standalone-tarball flow. Drives the "via nvm" header pill, the
  // progress block's copy, and the install-target preview text.
  installerKind?: InstallerKind;
  post: (msg: Outbound) => void;
  onMessage: (handler: (m: Inbound) => void) => () => void;
  onClose: () => void;
}

// Strip the archive extension from a Node tarball/zip filename so we
// can preview the install directory. Mirrors the logic used by the
// installer when it extracts the archive (the top-level directory in a
// Node archive matches the filename minus extension).
function dirFromFilename(filename: string): string {
  return filename
    .replace(/\.tar\.gz$/i, '')
    .replace(/\.tar\.xz$/i, '')
    .replace(/\.zip$/i, '')
    .replace(/\.7z$/i, '');
}

// Pick the default version: prefer the currentLts row, fall back to
// `current` (latest GA), then to the first entry. Returns '' when the
// listing is empty so the caller's effects can short-circuit.
function pickDefault(versions: NodeVersionDto[]): string {
  return (
    versions.find(v => v.currentLts)?.version
    ?? versions.find(v => v.current)?.version
    ?? versions[0]?.version
    ?? ''
  );
}

export function NodeDownloadDialog({
  versions, installRoot, installerKind: installerKindProp = 'download', post, onMessage, onClose,
}: Props) {
  const initial = pickDefault(versions);
  const [version, setVersion] = useState<string>(initial);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<{ fraction: number | null; detail?: string }>({ fraction: null });
  const [error, setError] = useState<string | null>(null);
  // Mirror the prop in state so a late `nodeDownloadList` (rare — the
  // App remounts the dialog on each open) can update the routing
  // indicator without us blowing away in-flight progress. Falls back to
  // 'download' when the protocol field is absent (older extension build).
  const [installerKind, setInstallerKind] = useState<InstallerKind>(installerKindProp);
  // Re-select the default if the versions array is replaced.
  const initialRef = useRef(initial);
  useEffect(() => {
    if (!versions.find(v => v.version === version)) {
      setVersion(initialRef.current);
    }
  }, [versions, version]);

  useEffect(() => {
    return onMessage(msg => {
      if (msg.cmd === 'nodeDownloadList') {
        setInstallerKind(msg.installerKind ?? 'download');
      } else if (msg.cmd === 'nodeDownloadProgress') {
        setPhase(msg.state);
        setProgress({ fraction: msg.fraction, detail: msg.detail });
      } else if (msg.cmd === 'nodeDownloadComplete') {
        setPhase('complete');
        setError(null);
        setTimeout(onClose, 600);
      } else if (msg.cmd === 'nodeDownloadError') {
        setPhase(msg.cancelled ? 'idle' : 'error');
        setError(msg.message);
      }
    });
  }, [onMessage, onClose]);

  const inFlight = phase === 'downloading' || phase === 'verifying' || phase === 'extracting' || phase === 'installing';
  const phaseLabel = useMemo(() => {
    switch (phase) {
      case 'downloading': return 'Downloading…';
      case 'verifying': return 'Verifying SHA-256…';
      case 'extracting': return 'Extracting…';
      case 'installing': return 'Installing via nvm…';
      case 'complete': return 'Done — selecting new Node';
      case 'error': return 'Failed';
      default: return '';
    }
  }, [phase]);

  const selected = versions.find(v => v.version === version);
  const sep = installRoot.includes('\\') && !installRoot.includes('/') ? '\\' : '/';
  // For nvm-routed installs the on-disk target is
  // <NVM_DIR>/versions/node/v<x.y.z>; the version label already carries
  // the leading 'v' from nodejs.org's index. The standalone-download
  // path keeps the existing behavior of deriving the directory from
  // the archive's filename.
  const targetPath = selected
    ? installerKind === 'nvm'
      ? `${installRoot.replace(/[\\/]+$/, '')}${sep}versions${sep}node${sep}${selected.version}`
      : `${installRoot.replace(/[\\/]+$/, '')}${sep}${dirFromFilename(selected.filename)}`
    : installRoot;
  const targetLabel = installerKind === 'nvm' ? 'Will be installed via nvm to:' : 'Will be installed to:';

  const onDownload = () => {
    if (!version) return;
    setError(null);
    setPhase('downloading');
    setProgress({ fraction: 0 });
    post({ cmd: 'downloadNode', version });
  };
  const onCancel = () => {
    if (inFlight) post({ cmd: 'cancelNodeDownload' });
    else onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Download Node.js"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={() => { if (!inFlight) onClose(); }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(560px, 92vw)',
          background: 'var(--vscode-editor-background)',
          color: 'var(--vscode-editor-foreground)',
          border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.5))',
          borderRadius: 4,
          padding: 18,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Download Node.js</h3>
        <p style={{ marginTop: 0, marginBottom: 10, fontSize: '0.92em', opacity: 0.85 }}>
          Pick a version, then click <strong>Download &amp; install</strong>.
          Versions come from nodejs.org (the official release index), the
          SHA-256 is verified, and Node is extracted ready to use. Once
          installed it's automatically selected in the Node installation
          field.
        </p>

        <div
          style={{
            marginBottom: 12,
            padding: '6px 10px',
            borderRadius: 3,
            background: 'var(--vscode-editorWidget-background, transparent)',
            border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.3))',
            fontSize: '0.85em',
          }}
          aria-label="Installation location"
        >
          <span style={{ opacity: 0.7 }}>{targetLabel}</span>{' '}
          <code style={{ wordBreak: 'break-all' }}>{targetPath}</code>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 10, alignItems: 'center' }}>
          <label htmlFor="node-version">Version</label>
          <select
            id="node-version"
            value={version}
            onChange={e => setVersion(e.target.value)}
            disabled={inFlight || versions.length === 0}
          >
            {/* The dialog only mounts once nodeDownloadList has replied,
                so an empty array means nodejs.org returned no entries
                (an outage or platform-mismatch). Tell the user instead
                of spinning forever. */}
            {versions.length === 0 ? (
              <option value="">No versions found</option>
            ) : versions.map(v => {
              const tags: string[] = [];
              if (v.currentLts) tags.push('Current LTS');
              else if (v.isLts) tags.push('LTS');
              if (v.current) tags.push('Latest');
              const suffix = tags.length ? `  —  ${tags.join(' · ')}` : '';
              return (
                <option key={v.version} value={v.version}>
                  {v.version}{suffix}
                </option>
              );
            })}
          </select>
          {selected && (
            <>
              <span />
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {installerKind === 'nvm' && (
                  <Badge kind="nvm" title="Installs via your local nvm (~/.nvm)">via nvm</Badge>
                )}
                {selected.currentLts && <Badge kind="lts-current">Current LTS</Badge>}
                {!selected.currentLts && selected.isLts && <Badge kind="lts">LTS</Badge>}
                {selected.current && <Badge kind="latest">Latest</Badge>}
              </div>
            </>
          )}
        </div>

        <div style={{ marginTop: 16, minHeight: 50 }}>
          {inFlight && phase === 'installing' && (
            // nvm-routed installs: text-only progress. nvm streams a
            // handful of human-readable lines (download, checksum,
            // build) — show the latest one under the heading, no
            // fraction bar (nvm doesn't surface byte counts cleanly).
            <>
              <div style={{ marginBottom: 6, fontSize: '0.9em' }}>
                <span>{phaseLabel}</span>
              </div>
              <div style={{ fontSize: '0.85em', opacity: 0.85, wordBreak: 'break-all' }}>
                {progress.detail ?? 'starting…'}
              </div>
            </>
          )}
          {inFlight && phase !== 'installing' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: '0.9em' }}>
                <span>{phaseLabel}</span>
                {progress.detail && <span style={{ opacity: 0.7 }}>{progress.detail}</span>}
              </div>
              <ProgressBar fraction={progress.fraction} />
            </>
          )}
          {phase === 'complete' && (
            <div style={{ color: 'var(--vscode-terminal-ansiGreen, #28a745)' }}>{phaseLabel}</div>
          )}
          {phase === 'error' && error && (
            <div style={{ color: 'var(--vscode-errorForeground)', fontSize: '0.9em' }}>{error}</div>
          )}
        </div>

        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="secondary" onClick={onCancel}>
            {inFlight ? 'Cancel' : 'Close'}
          </button>
          <button
            type="button"
            onClick={onDownload}
            disabled={inFlight || !version || phase === 'complete'}
          >
            {inFlight ? phaseLabel : 'Download & install'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Small inline pill — green for the current LTS line (the recommended
// pick), neutral grey for non-current LTS releases, a subdued outline
// for the "Latest" GA marker, and a blue-tinted variant for the "via
// nvm" routing indicator. Theme variables fall back to reasonable
// defaults when the editor doesn't define them.
function Badge({ kind, title, children }: {
  kind: 'lts-current' | 'lts' | 'latest' | 'nvm';
  title?: string;
  children: React.ReactNode;
}) {
  const palette: Record<typeof kind, React.CSSProperties> = {
    'lts-current': {
      background: 'var(--vscode-terminal-ansiGreen, #28a745)',
      color: '#fff',
      border: '1px solid transparent',
    },
    'lts': {
      background: 'var(--vscode-badge-background, rgba(128,128,128,0.3))',
      color: 'var(--vscode-badge-foreground, inherit)',
      border: '1px solid transparent',
    },
    'latest': {
      background: 'transparent',
      color: 'var(--vscode-editor-foreground)',
      border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.5))',
    },
    'nvm': {
      background: 'var(--vscode-statusBarItem-prominentBackground, rgba(14,99,156,0.3))',
      color: 'var(--vscode-statusBarItem-prominentForeground, var(--vscode-editor-foreground))',
      border: '1px solid transparent',
    },
  };
  return (
    <span
      title={title}
      style={{
        ...palette[kind],
        fontSize: '0.72em',
        padding: '1px 6px',
        borderRadius: 8,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
    >
      {children}
    </span>
  );
}

function ProgressBar({ fraction }: { fraction: number | null }) {
  if (fraction === null) {
    return (
      <div style={barTrackStyle}>
        <div
          style={{
            height: '100%',
            width: '40%',
            background: 'var(--vscode-progressBar-background, #0e639c)',
            animation: 'rcm-progress-marquee 1.4s linear infinite',
          }}
        />
        <style>{`@keyframes rcm-progress-marquee {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(250%); }
        }`}</style>
      </div>
    );
  }
  const pct = Math.round(fraction * 100);
  return (
    <div style={barTrackStyle} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div style={{
        height: '100%',
        width: `${pct}%`,
        background: 'var(--vscode-progressBar-background, #0e639c)',
        transition: 'width 120ms linear',
      }} />
    </div>
  );
}

const barTrackStyle: React.CSSProperties = {
  height: 6,
  background: 'var(--vscode-editorWidget-background, #2d2d30)',
  border: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.4))',
  borderRadius: 3,
  overflow: 'hidden',
};
