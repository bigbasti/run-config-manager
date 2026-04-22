interface Props {
  value: string;
  onChange: (next: string) => void;
  onPick: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

export function FolderPathInput({ value, onChange, onPick, onFocus, onBlur }: Props) {
  return (
    <div className="row-folder">
      <input value={value} onChange={e => onChange(e.target.value)} placeholder="(workspace folder)" onFocus={onFocus} onBlur={onBlur} />
      <button type="button" className="secondary" onClick={onPick}>Browse…</button>
    </div>
  );
}
