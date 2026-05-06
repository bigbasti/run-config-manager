// Shared placeholder dialog rendered the moment the user clicks a cloud
// button, while the extension is still talking to foojay / Apache /
// services.gradle.org. Without this, the cloud icon felt broken — clicks
// did nothing visible for several seconds while the listing fetched.
//
// All four download dialogs (JDK, Tomcat, Maven, Gradle) share this
// loading shell so the UX is consistent. Once the reply arrives App.tsx
// swaps in the real dialog with its full controls.

interface Props {
  title: string;
  // Optional sub-line; defaults to "Loading available versions…". Each
  // caller can specialize it ("Reading the Apache directory listing…")
  // if there's something more useful to say.
  detail?: string;
  onClose: () => void;
}

export function LoadingDialog({ title, detail, onClose }: Props) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-busy="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
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
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>{title}</h3>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 4px' }}>
          {/* Indeterminate spinner — same visual idiom as the verifying /
              extracting phases of the actual download dialog so the UX
              feels continuous. */}
          <div
            aria-hidden="true"
            style={{
              width: 16, height: 16, borderRadius: '50%',
              border: '2px solid var(--vscode-progressBar-background, #0e639c)',
              borderTopColor: 'transparent',
              animation: 'rcm-spinner-spin 0.9s linear infinite',
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: '0.92em' }}>
            {detail ?? 'Loading available versions…'}
          </span>
          <style>{`@keyframes rcm-spinner-spin {
            to { transform: rotate(360deg); }
          }`}</style>
        </div>

        <div style={{ marginTop: 4, display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
