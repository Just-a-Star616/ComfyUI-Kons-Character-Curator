import {useEffect, useState} from 'react';
import {api, CONFIG, thumb, waitJob} from './api.js';
import {AssetDrawer, AssetGrid, useLoad} from './ui.jsx';
import Character from './Character.jsx';
import Review from './Review.jsx';
import Datasets from './Datasets.jsx';
import Duplicates from './Duplicates.jsx';

export default function App() {
  const [page, setPage] = useState({name: 'library'});
  const go = (name, extra) => setPage({name, ...extra});
  return (
    <>
      <nav>
        <b>Kons Character Curator</b>
        {['library', 'assets', 'review', 'duplicates', 'datasets', 'servers'].map(n => <button key={n} className={page.name === n ? 'on' : ''} onClick={() => go(n)}>{n}</button>)}
      </nav>
      <main>
        {page.name === 'library' && <Library open={id => go('character', {id})} />}
        {page.name === 'assets' && <Assets />}
        {page.name === 'character' && <Character id={page.id} back={() => go('library')} />}
        {page.name === 'review' && <Review />}
        {page.name === 'datasets' && <Datasets />}
        {page.name === 'duplicates' && <Duplicates />}
        {page.name === 'servers' && <Servers />}
      </main>
    </>
  );
}

function Library({open}) {
  const [q, setQ] = useState('');
  const [chars, reload] = useLoad(() => api.get('/api/characters', {q}), [q]);
  const [msg, setMsg] = useState('');
  const create = async () => {
    const name = prompt('Character name');
    if (name) open((await api.post('/api/characters', {name})).id);
  };
  const importPresets = async () => {
    const path = prompt('Muse presets JSON', CONFIG.presets_path);
    if (!path) return;
    const r = await api.post('/api/import/presets', {path}).catch(e => ({error: e.message}));
    setMsg(r.error || `Imported ${r.characters} characters, ${r.outfits} outfits`);
    reload();
  };
  return (
    <>
      <div className="row">
        <input placeholder="Search name, trigger, franchise, tags, description" value={q} onChange={e => setQ(e.target.value)} />
        <button onClick={create}>New character</button>
        <button onClick={importPresets}>Import Muse presets</button>
        <span className="muted">{msg}</span>
      </div>
      <div className="grid big">
        {chars?.map(c => (
          <figure key={c.id} className="tile" onClick={() => open(c.id)}>
            {c.cover ? <img src={thumb({id: c.cover})} alt="" /> : <div className="ph">{c.name[0]}</div>}
            <figcaption><b>{c.name}</b>{c.franchise ? ` · ${c.franchise}` : ''} · {c.asset_count}<br />{c.tags.map(t => <span key={t} className="tag">{t}</span>)}</figcaption>
          </figure>
        ))}
      </div>
    </>
  );
}

const PAGE = 300;

function Scan({onDone}) {
  const [root, setRoot] = useState(CONFIG.scan_roots[0] || {path: '', per_character_folders: false});
  const [state, setState] = useState(null);
  const start = async () => {
    try {
      const {id} = await api.post('/api/import/scan', root);
      const job = await waitJob(id, j => setState(j.result?.total != null ? j.result : {total: '…', done: 0}));
      setState(job.result); onDone();
    } catch (e) { setState({error: e.message}); }
  };
  return (
    <div className="row">
      {CONFIG.scan_roots.length > 0 && <select value={root.path} onChange={e => setRoot(CONFIG.scan_roots.find(r => r.path === e.target.value) || {path: e.target.value, per_character_folders: false})}>
        {CONFIG.scan_roots.map(r => <option key={r.path} value={r.path}>{r.label}</option>)}
      </select>}
      <input placeholder="folder to scan" value={root.path} onChange={e => setRoot({...root, path: e.target.value})} />
      <label className="inline"><input type="checkbox" checked={root.per_character_folders} onChange={e => setRoot({...root, per_character_folders: e.target.checked})} />top folders are characters</label>
      <button onClick={start}>Scan folder</button>
      {state && <span className={state.error ? 'err' : 'muted'}>{state.error || `${state.done}/${state.total} · ${state.added ?? 0} new · ${state.duplicates ?? 0} duplicates${state.errors?.length ? ` · ${state.errors.length} unreadable` : ''}`}</span>}
    </div>
  );
}

function Assets() {
  const [f, setF] = useState({kind: '', rating: '', q: '', folder: '', character_id: '', hidden: false});
  const [assets, setAssets] = useState([]);
  const [more, setMore] = useState(false);
  const [chars, reloadChars] = useLoad(() => api.get('/api/characters'), []);
  const [selected, setSelected] = useState(null);
  const [open, setOpen] = useState(null);
  const load = async (offset = 0) => {
    const page = await api.get('/api/assets', {...f, limit: PAGE, offset});
    setAssets(a => offset ? [...a, ...page] : page);
    setMore(page.length === PAGE);
  };
  useEffect(() => { load(); }, [JSON.stringify(f)]);
  const set = (k, v) => setF({...f, [k]: v});
  const bulk = async data => { await api.post('/api/assets/bulk', {ids: [...selected], data}); setSelected(new Set()); load(); };
  const toggle = a => { const s = new Set(selected); s.has(a.id) ? s.delete(a.id) : s.add(a.id); setSelected(s); };
  return (
    <>
      <Scan onDone={() => { load(); reloadChars(); }} />
      <div className="row">
        <input placeholder="Search prompt, caption, tags" value={f.q} onChange={e => set('q', e.target.value)} />
        <input placeholder="Folder contains…" value={f.folder} onChange={e => set('folder', e.target.value)} />
        <select value={f.character_id} onChange={e => set('character_id', e.target.value)}>
          <option value="">All characters</option><option value="none">(unassigned)</option>
          {chars?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={f.kind} onChange={e => set('kind', e.target.value)}>
          <option value="">All kinds</option>
          {['import', 'source', 'view', 'edit', 'list_image', 'sheet', 'template'].map(k => <option key={k}>{k}</option>)}
        </select>
        <select value={f.rating} onChange={e => set('rating', e.target.value)}>
          <option value="">Any rating</option><option value="unrated">Unrated</option><option value="pass">Pass</option><option value="fail">Fail</option>
        </select>
        <label className="inline"><input type="checkbox" checked={f.hidden} onChange={e => set('hidden', e.target.checked)} />hidden</label>
        <button className={selected ? 'on' : ''} onClick={() => setSelected(selected ? null : new Set())}>Select</button>
        <button title="Assign unassigned images whose folder or file name matches a character name, trigger or alias" onClick={async () => {
          const r = await api.post('/api/assets/rematch'); alert(`Assigned ${r.matched} images`); load();
        }}>Re-match unassigned</button>
      </div>
      {selected && (
        <div className="row bulk">
          <span>{selected.size} selected</span>
          <button onClick={() => setSelected(new Set(assets.map(a => a.id)))}>All loaded</button>
          <select value="" onChange={e => e.target.value && bulk({character_id: e.target.value === 'none' ? null : +e.target.value})}>
            <option value="">Assign character…</option><option value="none">(unassign)</option>
            {chars?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value="" onChange={e => e.target.value && bulk({kind: e.target.value})}>
            <option value="">Set kind…</option>{['source', 'import', 'view', 'list_image', 'sheet', 'template'].map(k => <option key={k}>{k}</option>)}
          </select>
          <button onClick={() => bulk({kind: 'source'})}>Mark as source</button>
          <button onClick={() => bulk({rating: 'pass'})}>Pass</button>
          <button onClick={() => bulk({rating: 'fail'})}>Fail</button>
          <button onClick={() => bulk({rating: null})}>Clear rating</button>
          <button onClick={() => bulk({hidden: f.hidden ? 0 : 1})}>{f.hidden ? 'Unhide' : 'Hide'}</button>
          <button className="danger" disabled={!selected.size} onClick={async () => {
            if (!confirm(`Move ${selected.size} images (and every copy of them on disk) to the Trash and remove them from the catalogue?`)) return;
            await api.post('/api/assets/delete', {ids: [...selected]}); setSelected(new Set()); load();
          }}>Delete {selected.size}</button>
        </div>
      )}
      <AssetGrid assets={assets} selected={selected} onSelect={toggle} onOpen={a => setOpen(a.id)} />
      {more && <button onClick={() => load(assets.length)}>Load more</button>}
      {open && <AssetDrawer id={open} ids={assets.map(a => a.id)} onNavigate={setOpen} onClose={() => setOpen(null)} onChange={() => load()} />}
    </>
  );
}

function Servers() {
  const [servers, reload] = useLoad(() => api.get('/api/servers'), []);
  return <>{servers?.map(s => <ServerCard key={s.id} server={s} onSaved={reload} />)}</>;
}

function ServerCard({server, onSaved}) {
  const [s, setS] = useState(server);
  const [vision, setVision] = useState(JSON.stringify(server.models.vision || {}, null, 1));
  const [info, setInfo] = useState(null);
  const [msg, setMsg] = useState('');
  const m = s.models;
  const setM = (k, v) => setS({...s, models: {...m, [k]: v}});
  const check = async () => setInfo(await api.get(`/api/servers/${s.id}/info`));
  const save = async () => {
    try {
      await api.put(`/api/servers/${s.id}`, {...s, models: {...m, vision: JSON.parse(vision || '{}')}});
      setMsg('Saved'); onSaved();
    } catch (e) { setMsg(String(e.message)); }
  };
  const pick = (k, list) => (
    <label>{k}{info?.[k] && !info[k].includes(m[k]) && <span className="err"> not on this server</span>}<input list={`${s.id}-${k}`} value={m[k] ?? ''} onChange={e => setM(k, e.target.value)} />
      <datalist id={`${s.id}-${k}`}>{(info?.[k] || []).map(o => <option key={o} value={o} />)}</datalist></label>
  );
  return (
    <section className="card">
      <div className="row">
        <input value={s.name} onChange={e => setS({...s, name: e.target.value})} />
        <input value={s.url} onChange={e => setS({...s, url: e.target.value})} />
        <label className="inline" title="Civitai lookups (LoRA Info → Refresh from Civitai) run through a server with this ticked, e.g. one behind a VPN">
          <input type="checkbox" checked={!!s.civitai} onChange={e => setS({...s, civitai: e.target.checked ? 1 : 0})} />can reach Civitai</label>
        <button onClick={check}>Check</button>
        {info && <span className={info.online ? '' : 'err'}>{info.online ? `online · Muse ${info.muse ? '✓' : '✗'} · LC Vision ${info.lc_vision ? '✓' : '✗'}` : info.error}</span>}
      </div>
      <div className="form">
        {pick('unet')}{pick('clip')}{pick('clip_type')}{pick('vae')}
        <label>steps<input type="number" value={m.steps} onChange={e => setM('steps', +e.target.value)} /></label>
        <label>cfg<input type="number" step="0.1" value={m.cfg} onChange={e => setM('cfg', +e.target.value)} /></label>
        <label>kv_cache<select value={m.kv_cache || 'auto'} onChange={e => setM('kv_cache', e.target.value)}>{['auto', 'on', 'off'].map(o => <option key={o}>{o}</option>)}</select></label>
      </div>
      <label>LC Vision Loader inputs (for Describe and captioning){(() => {
        try { const n = JSON.parse(vision || '{}').model_name; return info?.vision_models && n && !info.vision_models.includes(n) ? <span className="err"> model_name not on this server</span> : null; } catch { return <span className="err"> invalid JSON</span>; }
      })()}</label>
      <textarea rows={4} className="mono" value={vision} onChange={e => setVision(e.target.value)} />
      <div className="row">
        {info?.vision_defaults && <button onClick={() => setVision(JSON.stringify(info.vision_defaults, null, 1))}>Use loader defaults</button>}
        <button onClick={save}>Save</button><span className="muted">{msg}</span>
      </div>
    </section>
  );
}
