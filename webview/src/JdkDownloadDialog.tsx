import { useEffect, useMemo, useRef, useState } from 'react';
import type { Inbound, Outbound, JdkPackageDto } from '../../src/shared/protocol';

// Modal dialog the user opens via the ⬇ icon next to the JDK select.
// Picks a vendor (foojay distribution) + version, then triggers a
// download/extract on the extension side. Progress streams in over the
// same postMessage channel the rest of the form uses.
//
// State machine:
//   idle (selects enabled, button = "Download & install")
//   downloading | verifying | extracting (selects disabled, progress bar)
//   complete (auto-closes on next paint)
//   error (shows message, retry by clicking button again)
//
// All long-running work happens server-side; the dialog is just a renderer
// of progress messages. Cancel sends `cancelJdkDownload` and waits for the
// server to confirm via `jdkDownloadError {cancelled:true}`.

type Phase =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'complete'
  | 'error'
  // Server detected a missing checksum for the chosen package and is
  // waiting for the user to either accept the unverified install or
  // cancel. The previous download has already happened — clicking
  // "Install anyway" re-runs install with allowUnverified=true (which
  // skips the verification step entirely on the second attempt).
  | 'needs-confirmation';

type DistroEntry = { apiName: string; label: string };

interface Props {
  // Initial payload shipped with `jdkDownloadList` — distros plus the
  // first distro's package list. Subsequent distros load lazily.
  distros: DistroEntry[];
  initialPackages: Record<string, JdkPackageDto[]>;
  // Absolute path the new JDK will be extracted into. Shown in the
  // dialog's "where it'll go" line so users aren't surprised by a
  // mystery folder appearing in their home dir.
  installRoot: string;
  post: (msg: Outbound) => void;
  // Forwarded inbound stream from App.tsx; this hook subscribes for the
  // dialog's lifecycle.
  onMessage: (handler: (m: Inbound) => void) => () => void;
  onClose: () => void;
}

export function JdkDownloadDialog({ distros, initialPackages, installRoot, post, onMessage, onClose }: Props) {
  const [packages, setPackages] = useState<Record<string, JdkPackageDto[]>>(initialPackages);
  const [distro, setDistro] = useState<string>(distros[0]?.apiName ?? '');
  const [packageId, setPackageId] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<{ fraction: number | null; detail?: string }>({ fraction: null });
  const [error, setError] = useState<string | null>(null);
  // Tracks whether we've asked for a distro's packages yet so flipping back
  // to a previously-loaded distro doesn't trigger a second request.
  const requestedDistros = useRef<Set<string>>(new Set(Object.keys(initialPackages)));

  // Auto-select the first package when packages change.
  useEffect(() => {
    if (!distro) return;
    const list = packages[distro];
    if (!list?.length) { setPackageId(''); return; }
    if (!list.find(p => p.id === packageId)) setPackageId(list[0].id);
  }, [distro, packages, packageId]);

  // Subscribe to inbound stream while the dialog is open. Unsubscribe on
  // unmount so a closed dialog can't keep mutating state.
  useEffect(() => {
    return onMessage(msg => {
      if (msg.cmd === 'jdkPackageList') {
        setPackages(prev => ({ ...prev, [msg.distro]: msg.packages }));
      } else if (msg.cmd === 'jdkDownloadProgress') {
        setPhase(msg.state);
        setProgress({ fraction: msg.fraction, detail: msg.detail });
      } else if (msg.cmd === 'jdkDownloadComplete') {
        setPhase('complete');
        setError(null);
        // Brief pause so the user sees the success state, then close.
        setTimeout(onClose, 600);
      } else if (msg.cmd === 'jdkDownloadError') {
        setPhase(msg.cancelled ? 'idle' : 'error');
        setError(msg.message);
      } else if (msg.cmd === 'jdkDownloadNeedsConfirmation') {
        setPhase('needs-confirmation');
        setError(msg.message);
      }
    });
  }, [onMessage, onClose]);

  // Lazy-load packages when the user switches vendor.
  useEffect(() => {
    if (!distro) return;
    if (requestedDistros.current.has(distro)) return;
    requestedDistros.current.add(distro);
    post({ cmd: 'listJdkPackages', distro });
  }, [distro, post]);

  const currentList = packages[distro] ?? [];
  // Distinguish "fetch in flight" from "fetch returned empty" so the
  // dropdown can show the right hint. Foojay can return zero packages
  // for an unsupported arch / OS combination.
  const hasReply = Object.prototype.hasOwnProperty.call(packages, distro);
  const isLoading = !hasReply;
  const isEmpty = hasReply && currentList.length === 0;
  const selectedPackage = currentList.find(p => p.id === packageId);
  // Build the target path the installer will use. We construct it with
  // the platform-correct separator: detected via the installRoot prefix
  // so the preview matches what the user sees in their file system.
  const sep = installRoot.includes('\\') && !installRoot.includes('/') ? '\\' : '/';
  const targetPath = selectedPackage
    ? `${installRoot.replace(/[\\/]+$/, '')}${sep}${selectedPackage.installDirName}`
    : installRoot;
  const inFlight = phase === 'downloading' || phase === 'verifying' || phase === 'extracting';
  const phaseLabel = useMemo(() => {
    switch (phase) {
      case 'downloading': return 'Downloading…';
      case 'verifying': return 'Verifying checksum…';
      case 'extracting': return 'Extracting…';
      case 'complete': return 'Done — selecting new JDK';
      case 'error': return 'Failed';
      default: return '';
    }
  }, [phase]);

  const onDownload = () => {
    if (!packageId) return;
    setError(null);
    setPhase('downloading');
    setProgress({ fraction: 0 });
    post({ cmd: 'downloadJdk', packageId, distro });
  };

  // User saw the "no checksum" warning and clicked "Install anyway". We
  // resend the same package with allowUnverified=true; the server
  // re-downloads (the previous archive was cleaned up) and skips
  // verification this time.
  const onInstallAnyway = () => {
    if (!packageId) return;
    setError(null);
    setPhase('downloading');
    setProgress({ fraction: 0 });
    post({ cmd: 'downloadJdk', packageId, distro, allowUnverified: true });
  };

  const onCancel = () => {
    if (inFlight) post({ cmd: 'cancelJdkDownload' });
    else onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Download a JDK"
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
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Download a JDK</h3>

        <p style={{ marginTop: 0, marginBottom: 10, fontSize: '0.92em', opacity: 0.85 }}>
          Pick a vendor and version, then click <strong>Download &amp; install</strong>.
          The archive is fetched directly from the vendor (via foojay.io's
          metadata), the SHA-256 checksum is verified, and the JDK is
          extracted ready to use — no admin/sudo required. Once installed it's
          automatically selected in the JDK dropdown.
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
          <label htmlFor="jdk-vendor">Vendor</label>
          <select
            id="jdk-vendor"
            value={distro}
            onChange={e => setDistro(e.target.value)}
            disabled={inFlight}
          >
            {distros.map(d => (
              <option key={d.apiName} value={d.apiName}>{d.label}</option>
            ))}
          </select>

          <label htmlFor="jdk-version">Version</label>
          <select
            id="jdk-version"
            value={packageId}
            onChange={e => setPackageId(e.target.value)}
            disabled={inFlight || currentList.length === 0}
          >
            {isLoading ? (
              <option value="">Loading…</option>
            ) : isEmpty ? (
              <option value="">No packages found for this distribution</option>
            ) : currentList.map(p => (
              <option key={p.id} value={p.id}>
                Java {p.versionLabel} — {humanSize(p.size)}
              </option>
            ))}
          </select>
        </div>

        {/* Progress region — always rendered so the dialog doesn't reflow,
            but visually empty when idle. */}
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
          {phase === 'needs-confirmation' && (
            <div
              style={{
                padding: '8px 10px',
                borderRadius: 3,
                color: 'var(--vscode-inputValidation-warningForeground, inherit)',
                background: 'var(--vscode-inputValidation-warningBackground, rgba(200,150,0,0.1))',
                border: '1px solid var(--vscode-inputValidation-warningBorder, rgba(200,150,0,0.5))',
                fontSize: '0.9em',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>⚠ Checksum unavailable</div>
              <div>
                The vendor metadata for this package didn't include a SHA-256 checksum,
                so we can't verify the archive's integrity. You can still install it,
                but the archive's authenticity won't be confirmed.
              </div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="secondary" onClick={onCancel}>
            {inFlight ? 'Cancel' : 'Close'}
          </button>
          {phase === 'needs-confirmation' ? (
            // User has to acknowledge the missing checksum. The button
            // wording is intentionally explicit so it doesn't read like a
            // normal "Continue".
            <button type="button" onClick={onInstallAnyway}>
              Install anyway (unverified)
            </button>
          ) : (
            <button
              type="button"
              onClick={onDownload}
              disabled={inFlight || !packageId || phase === 'complete'}
            >
              {inFlight ? phaseLabel : 'Download & install'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ProgressBar({ fraction }: { fraction: number | null }) {
  // null fraction = indeterminate. We render a barber-pole stripe so the
  // user sees motion (matters during the verifying / extracting phases
  // where we don't have byte counts).
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

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
