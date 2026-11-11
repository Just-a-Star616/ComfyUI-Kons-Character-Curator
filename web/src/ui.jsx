import {useEffect, useState} from 'react';
import {api, img, STYLES, thumb, VIEWS} from './api.js';

export function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const reload = () => fn().then(setData, e => setError(String(e.message || e)));
  useEffect(() => { reload(); }, deps);
  return [data, reload, error];
}

export const label = a => (a.view_id ? (VIEWS[a.view_id] || a.view_id) : a.kind) + (a.style && a.style !== 'none' ? ` · ${STYLES[a.style] || a.style}` : '');

export function AssetGrid({assets, selected, onSelect, onOpen}) {
  if (!assets?.length) return <p className="muted">No images.</p>;
  return (
    <div className="grid">
      {assets.map(a => (
        <figure key={a.id} className={`tile ${selected?.has(a.id) ? 'sel' : ''} ${a.rating || ''}`} onClick={e => (e.shiftKey || selected) && onSelect ? onSelect(a) : onOpen?.(a)}>
          <img src={thumb(a)} loading="lazy" alt="" />
          <figcaption>{a.favorite ? '★ ' : ''}{label(a)}{a.character_name ? ` · ${a.character_name}` : ''}</figcaption>
        </figure>
      ))}
    </div>
  );
}

// ids/onNavigate: the page's images in display order; ←/→ step through them, Esc closes.
export function AssetDrawer({id, ids, onNavigate, onClose, onChange, onDelete}) {
  const [a, reload] = useLoad(() => api.get(`/api/assets/${id}`), [id]);
  const [caption, setCaption] = useState('');
  useEffect(() => { setCaption(a?.captions.find(c => c.is_current)?.text || ''); }, [a]);
  const pos = ids ? ids.indexOf(id) : -1;
  const step = d => { if (pos >= 0 && ids[pos + d] != null) onNavigate(ids[pos + d]); };
  useEffect(() => {
    const onKey = e => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, ids]);
  if (!a) return null;
  const patch = async data => { await api.patch(`/api/assets/${id}`, data); reload(); onChange?.(); };
  return (
    <aside className="drawer">
      <div className="row drawernav">
        {pos >= 0 && <><button disabled={pos === 0} onClick={() => step(-1)} title="Previous (←)">‹</button>
          <span className="muted small">{pos + 1} / {ids.length}</span>
          <button disabled={pos === ids.length - 1} onClick={() => step(1)} title="Next (→)">›</button></>}
        <button className="close" onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      <a href={img(a)} target="_blank" rel="noreferrer"><img src={img(a)} alt="" /></a>
      <p><b>{label(a)}</b> · {a.kind} · {a.width}×{a.height}{a.seed != null ? ` · seed ${a.seed}` : ''}</p>
      {a.loras?.length > 0 && <p className="small">LoRA: {a.loras.map(l => `${l.lora.split(/[\\/]/).pop().replace(/\.safetensors$/, '')} ${l.strength}`).join(', ')}</p>}
      <div className="row">
        <button className={a.rating === 'pass' ? 'on' : ''} onClick={() => patch({rating: a.rating === 'pass' ? null : 'pass'})}>Pass</button>
        <button className={a.rating === 'fail' ? 'on' : ''} onClick={() => patch({rating: a.rating === 'fail' ? null : 'fail'})}>Fail</button>
        <button onClick={() => patch({favorite: a.favorite ? 0 : 1})}>{a.favorite ? '★' : '☆'}</button>
        <button onClick={() => patch({hidden: a.hidden ? 0 : 1})}>{a.hidden ? 'Unhide' : 'Hide'}</button>
      </div>
      <div className="row">
        <button className={a.kind === 'source' ? 'on' : ''} disabled={a.kind === 'source'} onClick={() => patch({kind: 'source'})}>{a.kind === 'source' ? 'Source ✓' : 'Mark as source'}</button>
        {a.character_id && <button onClick={async () => { await api.put(`/api/characters/${a.character_id}`, {cover_id: a.id}); onChange?.(); }}>Set as character thumbnail</button>}
        <button className="danger" onClick={async () => {
          if (!confirm(`Move this image${a.files.length > 1 ? ` and its ${a.files.length} copies on disk` : ''} to the Trash and remove it from the catalogue?`)) return;
          await api.post('/api/assets/delete', {ids: [a.id]}); onDelete ? onDelete(a.id) : onChange?.(); onClose();
        }}>Delete</button>
      </div>
      {a.prompt && <details><summary>Prompt</summary><p className="mono">{a.prompt}</p><button onClick={() => navigator.clipboard.writeText(a.prompt)}>Copy</button></details>}
      <label>Caption</label>
      <textarea rows={5} value={caption} onChange={e => setCaption(e.target.value)} />
      <button onClick={async () => { await api.put(`/api/assets/${id}/caption`, {text: caption}); reload(); }}>Save caption</button>
      {a.captions.length > 1 && <details><summary>Caption history ({a.captions.length})</summary>
        {a.captions.map(c => <p key={c.id} className="mono small" onClick={() => setCaption(c.text)}>[{c.source}] {c.text}</p>)}</details>}
      {a.files.length > 0 && <details><summary>On disk ({a.files.length} {a.files.length === 1 ? 'copy' : 'copies'})</summary>
        {a.files.map(f => <p key={f} className="mono small">{f}{a.files.length > 1 && <button className="small" onClick={async () => {
          if (confirm(`Move this copy to the Trash?\n${f}`)) { await api.post(`/api/assets/${a.id}/delete_copy`, {path: f}); reload(); }
        }}>Trash copy</button>}</p>)}</details>}
      {(a.lineage.length > 0 || a.children.length > 0) && <>
        <label>Lineage</label>
        <div className="lineage">
          {a.lineage.map(p => <img key={p.id} src={thumb(p)} title={label(p)} alt="" />)}
          <img className="me" src={img(a)} alt="" />
          {a.children.map(c => <img key={c.id} src={thumb(c)} title={label(c)} alt="" />)}
        </div>
      </>}
    </aside>
  );
}
