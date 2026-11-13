import {useEffect, useState} from 'react';
import {api, CONFIG, STYLES, thumb, waitJob} from './api.js';
import {AssetGrid, useLoad} from './ui.jsx';

const CAPTION_PROMPT = 'Caption this image in under 60 words: framing and camera angle, pose, expression, clothing and accessories, background, lighting. Never mention face, eyes, hair, ears, skin, species or body type. Do not name the subject; call them "the character".';

export default function Datasets() {
  const [list, reload] = useLoad(() => api.get('/api/datasets'), []);
  const [chars] = useLoad(() => api.get('/api/characters'), []);
  const [id, setId] = useState(null);
  const create = async () => {
    const name = prompt('Dataset name');
    if (name) { const r = await api.post('/api/datasets', {name}); await reload(); setId(r.id); }
  };
  return (
    <>
      <div className="row">
        <select value={id ?? ''} onChange={e => setId(e.target.value ? +e.target.value : null)}>
          <option value="">Pick a dataset…</option>{list?.map(d => <option key={d.id} value={d.id}>{d.name} ({d.size})</option>)}
        </select>
        <button onClick={create}>New dataset</button>
      </div>
      {id && <Dataset key={id} id={id} chars={chars || []} onChange={reload} />}
    </>
  );
}

function Dataset({id, chars, onChange}) {
  const [d, reload] = useLoad(() => api.get(`/api/datasets/${id}`), [id]);
  const [meta, setMeta] = useState(null);
  const [pool, setPool] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [find, setFind] = useState({from: '', to: ''});
  const [servers] = useLoad(() => api.get('/api/servers'), []);
  const [msg, setMsg] = useState('');
  const [serverId, setServerId] = useState('');
  const [picked, setPicked] = useState(new Set());
  const [restyle, setRestyle] = useState({style: 'anime', instruction: '', megapixels: 1.0, seed: 0, add: true});
  useEffect(() => { if (servers && !serverId) setServerId(servers[0]?.id ?? ''); }, [servers]);
  useEffect(() => { if (d) setMeta({name: d.name, trigger: d.trigger, character_id: d.character_id ?? ''}); }, [d]);
  useEffect(() => {
    if (meta?.character_id) api.get('/api/assets', {character_id: meta.character_id, rating: 'pass'}).then(setPool);
  }, [meta?.character_id]);
  if (!d || !meta) return null;
  const inSet = new Set(d.items.map(i => i.id));
  const saveMeta = async () => { await api.put(`/api/datasets/${id}`, {...meta, character_id: meta.character_id || null}); reload(); onChange(); };
  const add = async ids => { await api.post(`/api/datasets/${id}/items`, {asset_ids: ids}); setSelected(new Set()); reload(); onChange(); };
  const remove = async aid => { await api.post(`/api/datasets/${id}/items`, {asset_ids: [aid], remove: true}); reload(); onChange(); };
  const setOverride = (aid, caption) => api.put(`/api/datasets/${id}/items/${aid}`, {caption});
  const replaceAll = async () => {
    for (const i of d.items) {
      const text = i.override || i.caption || '';
      if (find.from && text.includes(find.from)) await setOverride(i.id, text.split(find.from).join(find.to));
    }
    reload();
  };
  const caption = async () => {
    const instruction = prompt('LC Vision caption instruction', CAPTION_PROMPT);
    if (!instruction) return;
    setMsg('Captioning…');
    try {
      const {id: jid} = await api.post('/api/jobs', {kind: 'caption', server_id: serverId, params: {asset_ids: targets(), instruction}});
      await waitJob(jid, j => j.result?.total && setMsg(`Captioning… ${j.result.done}/${j.result.total}`));
      setMsg('Captioned');
    } catch (e) { setMsg(`Error: ${e.message}`); }
    reload();  // Captions are saved per image, so show the finished ones even if the job failed.
  };
  const targets = () => picked.size ? [...picked] : d.items.map(i => i.id);
  const runRestyle = async () => {
    const ids = targets();
    if (!confirm(`Restyle ${ids.length} image${ids.length > 1 ? 's' : ''} as ${STYLES[restyle.style]} on ${servers.find(s => s.id === serverId)?.name}?`)) return;
    try {
      const {id: jid} = await api.post('/api/jobs', {kind: 'restyle', server_id: serverId, params: {
        asset_ids: ids, style: restyle.style, instruction: restyle.instruction, megapixels: restyle.megapixels, seed: restyle.seed,
        caption_suffix: restyle.style === 'none' ? '' : `${STYLES[restyle.style].toLowerCase()} style`, dataset_id: restyle.add ? id : null}});
      await waitJob(jid, j => setMsg(`Restyling ${j.result?.done ?? 0}/${ids.length}…`));
      setMsg(`Restyled ${ids.length}`); setPicked(new Set()); reload(); onChange();
    } catch (e) { setMsg(`Error: ${e.message}`); }
  };
  const exportSet = async () => {
    const target = prompt('Export into folder', CONFIG.export_dir);
    if (!target) return;
    const r = await api.post(`/api/datasets/${id}/export`, {target}).catch(e => ({error: e.message}));
    setMsg(r.error || `Exported ${r.count} images to ${r.folder}`);
  };
  return (
    <>
      <section className="card form">
        <label>name<input value={meta.name} onChange={e => setMeta({...meta, name: e.target.value})} /></label>
        <label>trigger word<input placeholder="[trigger]" value={meta.trigger} onChange={e => setMeta({...meta, trigger: e.target.value})} /></label>
        <label>character<select value={meta.character_id} onChange={e => setMeta({...meta, character_id: e.target.value ? +e.target.value : ''})}>
          <option value="">(any)</option>{chars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <button onClick={saveMeta}>Save</button>
      </section>
      <div className="row">
        <h3>{d.items.length} images</h3>
        <select value={serverId} onChange={e => setServerId(+e.target.value)}>{servers?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <button disabled={!serverId || !d.items.length} onClick={caption}>Caption {picked.size ? `${picked.size} selected` : 'all'} with LC Vision</button>
        <input placeholder="find" value={find.from} onChange={e => setFind({...find, from: e.target.value})} />
        <input placeholder="replace" value={find.to} onChange={e => setFind({...find, to: e.target.value})} />
        <button onClick={replaceAll}>Replace in captions</button>
        <button disabled={!d.items.length} onClick={exportSet}>Export</button>
        <span className={msg.startsWith('Error') ? 'err' : 'muted'}>{msg}</span>
      </div>
      <section className="card">
        <div className="row">
          <b>Restyle (I2I)</b>
          <select value={restyle.style} onChange={e => setRestyle({...restyle, style: e.target.value})}>{Object.entries(STYLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input placeholder="Extra instruction, e.g. neon cyberpunk city at night" value={restyle.instruction} onChange={e => setRestyle({...restyle, instruction: e.target.value})} />
          <label className="inline">MP<input type="number" step="0.05" style={{width: 70}} value={restyle.megapixels} onChange={e => setRestyle({...restyle, megapixels: +e.target.value})} /></label>
          <label className="inline">seed<input type="number" style={{width: 90}} value={restyle.seed} onChange={e => setRestyle({...restyle, seed: +e.target.value})} /></label>
          <label className="inline"><input type="checkbox" checked={restyle.add} onChange={e => setRestyle({...restyle, add: e.target.checked})} />add results here</label>
          <button disabled={!serverId || !d.items.length} onClick={runRestyle}>Restyle {picked.size ? `${picked.size} selected` : 'all'}</button>
        </div>
        <span className="muted small">Runs the node's image_edit mode per image; results are linked to their source and keep its caption plus the style.</span>
      </section>
      <div className="row"><span className="muted">{picked.size ? `${picked.size} selected` : 'Tick images to restyle or caption only those'}</span>
        {picked.size > 0 && <button onClick={() => setPicked(new Set())}>Clear selection</button>}</div>
      <div className="captions">
        {d.items.map(i => (
          <div key={i.id} className={`capitem ${picked.has(i.id) ? 'sel' : ''}`}>
            <label className="pick"><input type="checkbox" checked={picked.has(i.id)} onChange={() => { const s = new Set(picked); s.has(i.id) ? s.delete(i.id) : s.add(i.id); setPicked(s); }} />
              <img src={thumb(i)} alt="" /></label>
            <textarea rows={4} defaultValue={i.override || i.caption || ''} key={`${i.id}-${i.override}-${i.caption}`} onBlur={e => e.target.value !== (i.override || i.caption || '') && setOverride(i.id, e.target.value)} />
            <button onClick={() => remove(i.id)}>Remove</button>
          </div>
        ))}
      </div>
      {meta.character_id ? <>
        <div className="row"><h3>Passed images not in this set</h3><span className="muted">click to select</span>
          <button disabled={!selected.size} onClick={() => add([...selected])}>Add {selected.size}</button>
          <button onClick={() => add((pool || []).filter(a => !inSet.has(a.id)).map(a => a.id))}>Add all</button></div>
        <AssetGrid assets={(pool || []).filter(a => !inSet.has(a.id))} selected={selected}
          onSelect={a => { const s = new Set(selected); s.has(a.id) ? s.delete(a.id) : s.add(a.id); setSelected(s); }} />
      </> : <p className="muted">Pick a character to add its passed images.</p>}
    </>
  );
}
