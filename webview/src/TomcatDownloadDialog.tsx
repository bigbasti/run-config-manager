import { useEffect, useMemo, useRef, useState } from 'react';
import type { Inbound, Outbound, TomcatVersionDto } from '../../src/shared/protocol';

// Modal dialog for downloading + installing an Apache Tomcat. Mirrors
// the JDK download dialog's UX (vendor/version selects, progress bar,
// cancel) but uses Apache's release listings instead of foojay.
//
// Discovery is data-driven: the major lines come straight from the
// `https://downloads.apache.org/tomcat/` directory listing on the
// extension side, so when Tomcat 12 lands it will appear automatically.

type Phase = 'idle' | 'downloading' | 'verifying' | 'extracting' | 'complete' | 'error';

interface Props {
  majors: Array<{ major: number; label: string }>;
  initialVersions: Record<number, TomcatVersionDto[]>;
  installRoot: string;
  post: (msg: Outbound) => void;
  onMessage: (handler: (m: Inbound) => void) => () => void;
  onClose: () => void;
}

export function TomcatDownloadDialog({
  majors, initialVersions, installRoot, post, onMessage, onClose,
}: Props) {
  const [versions, setVersions] = useState<Record<number, TomcatVersionDto[]>>(initialVersions);
  const [major, setMajor] = useState<number>(majors[0]?.major ?? 0);
  const [version, setVersion] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<{ fraction: number | null; detail?: string }>({ fraction: null });
  const [error, setError] = useState<string | null>(null);
  const requestedMajors = useRef<Set<number>>(new Set(Object.keys(initialVersions).map(Number)));

  // Auto-select the newest version on the selected major. parseVersionListing
  // already returns sorted (newest first), so .[0] is the right default.
  useEffect(() => {
    const list = versions[major];
    if (!list?.length) { setVersion(''); return; }
    if (!list.find(v => v.version === version)) setVersion(list[0].version);
  }, [major, versions, version]);

  // Subscribe to inbound stream while open.
  useEffect(() => {
    return onMessage(msg => {
      if (msg.cmd === 'tomcatVersionList') {
        setVersions(prev => ({ ...prev, [msg.major]: msg.versions }));
      } else if (msg.cmd === 'tomcatDownloadProgress') {
        setPhase(msg.state);
        setProgress({ fraction: msg.fraction, detail: msg.detail });
      } else if (msg.cmd === 'tomcatDownloadComplete') {
        setPhase('complete');
        setError(null);
        setTimeout(onClose, 600);
      } else if (msg.cmd === 'tomcatDownloadError') {
        setPhase(msg.cancelled ? 'idle' : 'error');
        setError(msg.message);
      }
    });
  }, [onMessage, onClose]);

  // Lazy-load versions when the user switches major lines.
  useEffect(() => {
    if (!major) return;
    if (requestedMajors.current.has(major)) return;
    requestedMajors.current.add(major);
    post({ cmd: 'listTomcatVersions', major });
  }, [major, post]);

  const currentList = versions[major] ?? [];
  const inFlight = phase === 'downloading' || phase === 'verifying' || phase === 'extracting';
  const phaseLabel = useMemo(() => {
    switch (phase) {
      case 'downloading': return 'Downloading…';
      case 'verifying': return 'Verifying SHA-512…';
      case 'extracting': return 'Extracting…';
      case 'complete': return 'Done — selecting new Tomcat';
      case 'error': return 'Failed';
      default: return '';
    }
  }, [phase]);

  const selected = currentList.find(v => v.version === version);
  const sep = installRoot.includes('\\') && !installRoot.includes('/') ? '\\' : '/';
  const targetPath = selected
    ? `${installRoot.replace(/[\\/]+$/, '')}${sep}${selected.installDirName}`
    : installRoot;

  const onDownload = () => {
    if (!version) return;
    setError(null);
    setPhase('downloading');
    setProgress({ fraction: 0 });
    post({ cmd: 'downloadTomcat', major, version });
  };

  const onCancel = () => {
    if (inFlight) post({ cmd: 'cancelTomcatDownload' });
    else onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Download a Tomcat"
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
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Download Apache Tomcat</h3>
        <p style={{ marginTop: 0, marginBottom: 10, fontSize: '0.92em', opacity: 0.85 }}>
          Pick a major line and a version, then click <strong>Download &amp; install</strong>.
          The archive is fetched directly from Apache's mirrors, the SHA-512 is verified,
          and Tomcat is extracted ready to use — no admin/sudo required. Once installed it's
          automatically selected in the Tomcat installation field.
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
          <span style={{ opacity: 0.7 }}>Will be installed to:</span>{' '}
          <code style={{ wordBreak: 'break-all' }}>{targetPath}</code>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 10, alignItems: 'center' }}>
          <label htmlFor="tomcat-major">Major line</label>
          <select
            id="tomcat-major"
            value={major}
            onChange={e => setMajor(Number(e.target.value))}
            disabled={inFlight}
          >
            {majors.map(m => (
              <option key={m.major} value={m.major}>{m.label}</option>
            ))}
          </select>

          <label htmlFor="tomcat-version">Version</label>
          <select
            id="tomcat-version"
            value={version}
            onChange={e => setVersion(e.target.value)}
            disabled={inFlight || currentList.length === 0}
          >
            {currentList.length === 0 ? (
              <option value="">Loading…</option>
            ) : currentList.map(v => (
              <option key={v.version} value={v.version}>{v.versionLabel}</option>
            ))}
          </select>
        </div>

        <div style={{ marginTop: 16, minHeight: 50 }}>
          {inFlight && (
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
