import { useEffect, useMemo, useRef, useState } from 'react';
import type { Inbound, Outbound, GradleVersionDto } from '../../src/shared/protocol';

// Modal dialog for downloading + installing a Gradle distribution.
// Single version select — Gradle's release line is unified, no
// "major-line" split like Maven and Tomcat. Versions come from
// services.gradle.org/versions/all (the same endpoint the Gradle
// wrapper uses), so new releases appear automatically.

type Phase = 'idle' | 'downloading' | 'verifying' | 'extracting' | 'complete' | 'error';

interface Props {
  versions: GradleVersionDto[];
  installRoot: string;
  post: (msg: Outbound) => void;
  onMessage: (handler: (m: Inbound) => void) => () => void;
  onClose: () => void;
}

export function GradleDownloadDialog({
  versions, installRoot, post, onMessage, onClose,
}: Props) {
  // Pre-select the version flagged `current` by services.gradle.org;
  // fall back to the first entry (newest) when no flag is set.
  const initial = versions.find(v => v.current)?.version ?? versions[0]?.version ?? '';
  const [version, setVersion] = useState<string>(initial);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<{ fraction: number | null; detail?: string }>({ fraction: null });
  const [error, setError] = useState<string | null>(null);
  // Re-select the default if the versions array is replaced.
  const initialRef = useRef(initial);
  useEffect(() => {
    if (!versions.find(v => v.version === version)) {
      setVersion(initialRef.current);
    }
  }, [versions, version]);

  useEffect(() => {
    return onMessage(msg => {
      if (msg.cmd === 'gradleDownloadProgress') {
        setPhase(msg.state);
        setProgress({ fraction: msg.fraction, detail: msg.detail });
      } else if (msg.cmd === 'gradleDownloadComplete') {
        setPhase('complete');
        setError(null);
        setTimeout(onClose, 600);
      } else if (msg.cmd === 'gradleDownloadError') {
        setPhase(msg.cancelled ? 'idle' : 'error');
        setError(msg.message);
      }
    });
  }, [onMessage, onClose]);

  const inFlight = phase === 'downloading' || phase === 'verifying' || phase === 'extracting';
  const phaseLabel = useMemo(() => {
    switch (phase) {
      case 'downloading': return 'Downloading…';
      case 'verifying': return 'Verifying SHA-256…';
      case 'extracting': return 'Extracting…';
      case 'complete': return 'Done — selecting new Gradle';
      case 'error': return 'Failed';
      default: return '';
    }
  }, [phase]);

  const selected = versions.find(v => v.version === version);
  const sep = installRoot.includes('\\') && !installRoot.includes('/') ? '\\' : '/';
  const targetPath = selected
    ? `${installRoot.replace(/[\\/]+$/, '')}${sep}${selected.installDirName}`
    : installRoot;

  const onDownload = () => {
    if (!version) return;
    setError(null);
    setPhase('downloading');
    setProgress({ fraction: 0 });
    post({ cmd: 'downloadGradle', version });
  };
  const onCancel = () => {
    if (inFlight) post({ cmd: 'cancelGradleDownload' });
    else onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Download Gradle"
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
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Download Gradle</h3>
        <p style={{ marginTop: 0, marginBottom: 10, fontSize: '0.92em', opacity: 0.85 }}>
          Pick a version, then click <strong>Download &amp; install</strong>.
          Versions come from services.gradle.org (the official endpoint the Gradle
          wrapper uses), the SHA-256 is verified, and Gradle is extracted ready to
          use. Once installed it's automatically selected in the Gradle installation
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
          <span style={{ opacity: 0.7 }}>Will be installed to:</span>{' '}
          <code style={{ wordBreak: 'break-all' }}>{targetPath}</code>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 10, alignItems: 'center' }}>
          <label htmlFor="gradle-version">Version</label>
          <select
            id="gradle-version"
            value={version}
            onChange={e => setVersion(e.target.value)}
            disabled={inFlight || versions.length === 0}
          >
            {/* The dialog only mounts once gradleDownloadList has
                replied, so "empty array" here means services.gradle.org
                returned no GA versions (extremely rare — would indicate
                an outage or filter mismatch). Tell the user instead of
                spinning forever. */}
            {versions.length === 0 ? (
              <option value="">No versions found</option>
            ) : versions.map(v => (
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
