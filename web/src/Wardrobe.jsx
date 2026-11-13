import {useState} from 'react';
import {api, CATEGORIES, PARTS, thumb} from './api.js';
import {AssetDrawer, AssetGrid, useLoad} from './ui.jsx';

// Outfits and accessories across all characters. Shared items (no character) are offered on every character's page.
const KINDS = {
  outfit: {path: '/api/outfits', label: 'Outfits', images: 'outfit_id', blank: {text: '', footwear: ''}},
  accessory: {path: '/api/accessories', label: 'Accessories', images: 'accessory', blank: {text: '', category: 'weapon', part: 'hands'}},
};

export default function Wardrobe() {
  const [kind, setKind] = useState('outfit');
  const [owner, setOwner] = useState('');
  const [q, setQ] = useState('');
  const [chars] = useLoad(() => api.get('/api/characters'), []);
  const [items, reload] = useLoad(() => api.get(KINDS[kind].path, {owner, q}), [kind, owner, q]);
  const [open, setOpen] = useState(null);
  const create = async () => {
    const name = prompt(`New shared ${kind} name`);
    if (!name) return;
    const r = await api.post(KINDS[kind].path, {...KINDS[kind].blank, name, character_id: owner && owner !== 'shared' ? +owner : null});
    await reload(); setOpen(r.id);
  };
  return (
    <>
      <div className="row">
        {Object.entries(KINDS).map(([k, v]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => { setKind(k); setOpen(null); }}>{v.label}</button>)}
        <select value={owner} onChange={e => setOwner(e.target.value)}>
          <option value="">Everyone's</option><option value="shared">Shared only</option>
          {chars?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input placeholder="search name, text, tags" value={q} onChange={e => setQ(e.target.value)} />
        <button onClick={create}>New {owner && owner !== 'shared' ? '' : 'shared '}{kind}</button>
        <span className="muted">{items ? `${items.length} ${KINDS[kind].label.toLowerCase()}` : 'Loading…'}</span>
      </div>
      {kind === 'accessory' && <p className="muted small">An accessory joins the designer part prompt for where it is worn, so it only appears on views showing that part: held items stay out of portraits.</p>}
      <div className="wardrobe">
        {items?.map(w => (
          <figure key={w.id} className={`tile ${open === w.id ? 'sel' : ''}`} onClick={() => setOpen(open === w.id ? null : w.id)}>
            {w.cover ? <img src={thumb({id: w.cover})} loading="lazy" alt="" /> : <div className="ph">{kind === 'outfit' ? '👗' : '🗡'}</div>}
            <figcaption><b>{w.name}</b><br />
              <span className="tag">{w.character_name || 'shared'}</span>
              {kind === 'accessory' && <span className="tag">{w.category}</span>}
              <span className="muted small">{w.image_count} images</span>
            </figcaption>
          </figure>
        ))}
      </div>
      {open && items?.find(w => w.id === open) && <Editor key={`${kind}${open}`} kind={kind} item={items.find(w => w.id === open)} chars={chars || []}
        onChange={reload} onClose={() => setOpen(null)} />}
    </>
  );
}

function Editor({kind, item, chars, onChange, onClose}) {
  const [w, setW] = useState({...item, tags: item.tags.join(', ')});
  const [copyTo, setCopyTo] = useState('');
  const [images, setImages] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [msg, setMsg] = useState('');
  const path = `${KINDS[kind].path}/${item.id}`;
  const set = (k, v) => setW({...w, [k]: v});
  const save = async () => {
    await api.put(path, {...w, tags: w.tags.split(',').map(t => t.trim()).filter(Boolean)});
    setMsg('Saved'); onChange();
  };
  const copy = async () => {
    await api.post(`${path}/copy`, {character_id: copyTo === 'shared' ? null : +copyTo});
    setMsg(`Copied to ${copyTo === 'shared' ? 'shared' : chars.find(c => c.id === +copyTo)?.name}`); onChange();
  };
  const remove = async () => {
    if (!confirm(`Delete ${kind} "${item.name}"? Images made with it are kept.`)) return;
    await api.del(path); onClose(); onChange();
  };
  return (
    <section className="card">
      <div className="row"><h3>{item.name}</h3><button onClick={onClose}>Close</button><span className="muted">{msg}</span></div>
      <div className="form">
        <label>name<input value={w.name} onChange={e => set('name', e.target.value)} /></label>
        <label title="Shared items are offered to every character; editing one changes it everywhere">belongs to<select value={w.character_id ?? ''} onChange={e => set('character_id', e.target.value ? +e.target.value : null)}>
          <option value="">Shared</option>{chars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        {kind === 'accessory' && <>
          <label>category<select value={w.category} onChange={e => set('category', e.target.value)}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></label>
          <label title="The designer part this joins; it only appears on views where that part is visible">worn / shown at<select value={w.part} onChange={e => set('part', e.target.value)}>
            {Object.entries(PARTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </>}
        <label>tags<input value={w.tags} onChange={e => set('tags', e.target.value)} /></label>
      </div>
      <label>{kind === 'outfit' ? 'outfit' : 'description, e.g. "Holding a curved katana with a red-wrapped hilt in the right hand."'}
        <textarea rows={3} value={w.text} onChange={e => set('text', e.target.value)} /></label>
      {kind === 'outfit' && <label>footwear (designer part prompt, only on views showing feet)<input value={w.footwear} onChange={e => set('footwear', e.target.value)} /></label>}
      <div className="row">
        <button onClick={save}>Save</button>
        <select value={copyTo} onChange={e => setCopyTo(e.target.value)}>
          <option value="">Copy to…</option><option value="shared">Shared</option>{chars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button disabled={!copyTo} onClick={copy}>Copy</button>
        <button onClick={() => api.get('/api/assets', {[KINDS[kind].images]: item.id, limit: 300}).then(setImages)}>Show {item.image_count} images</button>
        <button className="danger" onClick={remove}>Delete</button>
      </div>
      {images && <AssetGrid assets={images} onOpen={a => setDrawer(a.id)} />}
      {drawer && <AssetDrawer id={drawer} ids={images.map(a => a.id)} onNavigate={setDrawer} onClose={() => setDrawer(null)} />}
    </section>
  );
}
