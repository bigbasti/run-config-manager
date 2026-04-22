interface Props {
  value: string;
  onChange: (next: string) => void;
  onPick: () => void;
}

export function FolderPathInput({ value, onChange, onPick }: Props) {
  return (
    <div className="row-folder">
      <input value={value} onChange={e => onChange(e.target.value)} placeholder="(workspace folder)" />
      <button type="button" className="secondary" onClick={onPick}>Browse…</button>
    </div>
  );
}
