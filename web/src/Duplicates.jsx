import {useEffect, useState} from 'react';
import {api, thumb} from './api.js';
import {AssetDrawer, label, useLoad} from './ui.jsx';

// Near-duplicates (perceptual hash) to verify and prune, and exact images stored more than once on disk.
// Actions update the loaded groups in place; only changing the filters searches again.
export default function Duplicates() {
  const [chars] = useLoad(() => api.get('/api/characters'), []);
  const [tab, setTab] = useState('near');
  const [threshold, setThreshold] = useState(6);
  const [characterId, setCharacterId] = useState('');
  const [groups, setGroups] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    setGroups(null);
    setSelected(new Set());
    (tab === 'near' ? api.get('/api/duplicates', {threshold, character_id: characterId}) : api.get('/api/copies', {character_id: characterId})).then(setGroups);
  }, [tab, threshold, characterId]);

  const toggle = ids => {
    const s = new Set(selected);
    const on = ids.some(id => !s.has(id));
    ids.forEach(id => on ? s.add(id) : s.delete(id));
    setSelected(s);
  };
  const keepOnly = (g, a) => {
    const s = new Set(selected);
    g.forEach(x => x.id === a.id ? s.delete(x.id) : s.add(x.id));
    setSelected(s);
  };
  // Drop removed images from the loaded groups; a group left with one image is no longer a duplicate group.
  const dropLocal = ids => setGroups(gs => gs.map(g => g.filter(a => !ids.has(a.id))).filter(g => g.length > 1));
  const deleteSelected = async () => {
    const ids = [...selected];
    if (!confirm(`Move ${ids.length} image${ids.length > 1 ? 's' : ''} (and every copy on disk) to the Trash and remove ${ids.length > 1 ? 'them' : 'it'} from the catalogue?`)) return;
    setBusy(`Deleting ${ids.length}…`);
    try {
      await api.post('/api/assets/delete', {ids});
      dropLocal(new Set(ids));
      setSelected(new Set());
      setBusy(`Deleted ${ids.length}`);
    } catch (e) { setBusy(`Error: ${e.message}`); }
  };
  const notDuplicates = async g => {
    await api.post('/api/duplicates/ignore', {ids: g.map(a => a.id)});
    setGroups(gs => gs.filter(x => x !== g));
    setSelected(s => new Set([...s].filter(id => !g.some(a => a.id === id))));
  };
  const trashCopy = async (a, f) => {
    if (!confirm(`Move this copy to the Trash? The image stays in the catalogue via its other copies.\n${f}`)) return;
    await api.post(`/api/assets/${a.id}/delete_copy`, {path: f});
    setGroups(gs => gs.map(x => x.id === a.id ? {...x, files: x.files.filter(p => p !== f), copies: x.copies - 1} : x).filter(x => x.files.length > 1));
  };

  return (
    <>
      <div className="row">
        <button className={tab === 'near' ? 'on' : ''} onClick={() => setTab('near')}>Possible duplicates</button>
        <button className={tab === 'copies' ? 'on' : ''} onClick={() => setTab('copies')}>Copies on disk</button>
        <select value={characterId} onChange={e => setCharacterId(e.target.value)}>
          <option value="">All characters</option>{chars?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {tab === 'near' && <label className="inline">similarity
          <input type="range" min="0" max="40" value={threshold} onChange={e => setThreshold(+e.target.value)} />
          {threshold === 0 ? 'near-identical' : `≤ ${threshold} of 256 bits apart`}</label>}
        <span className="muted">{groups ? `${groups.length} groups${groups.length >= 100 ? ' (first 100)' : ''}` : 'Searching…'}</span>
      </div>
      {tab === 'near' && (
        <div className="row bulk">
          <button className="danger" disabled={!selected.size || busy.startsWith('Deleting')} onClick={deleteSelected}>Delete selected ({selected.size})</button>
          <button disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
          <span className={busy.startsWith('Error') ? 'err' : 'muted'}>{busy || 'Tick images, or use Keep only this to tick the rest of a group.'}</span>
        </div>
      )}
      {tab === 'near' && groups?.map(g => (
        <div key={g[0].id} className="dupgroup">
          {g.map(a => (
            <figure key={a.id} className={`${a.rating || ''} ${selected.has(a.id) ? 'marked' : ''}`}>
              <label className="pick"><input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle([a.id])} />#{a.id}</label>
              <img src={thumb(a)} alt="" onClick={() => setOpen(a.id)} />
              <figcaption>
                {a.width}×{a.height} · {label(a)}<br />{a.character_name || '(unassigned)'}{a.rating ? ` · ${a.rating}` : ''}{a.copies > 1 ? ` · ${a.copies} copies` : ''}
                <p className="mono small" title={a.path}>{a.path.split('/').slice(-2).join('/')}</p>
                <button onClick={() => keepOnly(g, a)}>Keep only this</button>
              </figcaption>
            </figure>
          ))}
          <div className="col">
            <button onClick={() => toggle(g.map(a => a.id))}>Tick all</button>
            <button onClick={() => notDuplicates(g)}>Not duplicates</button>
          </div>
        </div>
      ))}
      {tab === 'copies' && groups?.map(a => (
        <div key={a.id} className="dupgroup">
          <figure><img src={thumb(a)} alt="" onClick={() => setOpen(a.id)} /><figcaption>#{a.id} · {a.character_name || '(unassigned)'} · {a.copies} copies</figcaption></figure>
          <div>
            {a.files.map(f => <p key={f} className="mono small">{f} <button className="small" onClick={() => trashCopy(a, f)}>Trash copy</button></p>)}
          </div>
        </div>
      ))}
      {open && <AssetDrawer id={open} ids={(groups || []).flatMap(g => tab === 'near' ? g.map(a => a.id) : [g.id])} onNavigate={setOpen} onClose={() => setOpen(null)} onDelete={id => { dropLocal(new Set([id])); setSelected(s => new Set([...s].filter(x => x !== id))); }} />}
    </>
  );
}
