import {useEffect, useRef, useState} from 'react';
import {api, img, PARTS, STYLES, thumb, waitJob, VIEWS, VIEW_PRESETS} from './api.js';
import {AssetDrawer, AssetGrid, useLoad} from './ui.jsx';
import {LoraRows} from './Loras.jsx';

const EMPTY_CONTROL = {locked: [], seeds: {}, edits: {}, edit_seeds: {}, prompts: {}};
const DESCRIBE = {prompt: 'describe_character', outfit: 'describe_outfit', body_details: 'describe_body', parts: 'describe_parts'};
// Designer part prompts: each is only used in the views where that part is visible.
const PART_FIELDS = Object.fromEntries(['head_hair', 'face', 'upper_clothing', 'back_clothing', 'lower_body', 'hands', 'footwear'].map(k => [k, PARTS[k]]).concat([['other', 'Other (every view)']]));
const withParts = (stateJson, fn) => { let s = {}; try { s = JSON.parse(stateJson || '{}'); } catch { /* broken state: start over */ } const parts = fn({...s.part_prompts}); for (const k of Object.keys(parts)) if (!parts[k]) delete parts[k]; return JSON.stringify({...s, part_prompts: parts}); };

export default function Character({id, back}) {
  const [c, reload] = useLoad(() => api.get(`/api/characters/${id}`), [id]);
  const [form, setForm] = useState(null);
  const [outfitId, setOutfitId] = useState(null);
  const [kind, setKind] = useState('');
  const [style, setStyle] = useState('');
  const [lora, setLora] = useState('');
  const [usedLoras, setUsedLoras] = useState([]);
  const [assets, setAssets] = useState([]);
  const [more, setMore] = useState(false);
  const loadAssets = async (offset = 0) => {
    const page = await api.get('/api/assets', {character_id: id, kind, style, lora, limit: 300, offset});
    setAssets(a => offset ? [...a, ...page] : page);
    setMore(page.length === 300);
  };
  const reloadAssets = () => loadAssets();
  useEffect(() => { loadAssets(); }, [id, kind, style, lora]);
  useEffect(() => { api.get('/api/assets/loras', {character_id: id}).then(setUsedLoras); }, [id, assets.length]);
  const [open, setOpen] = useState(null);
  const [msg, setMsg] = useState('');
  const [chars] = useLoad(() => api.get('/api/characters'), []);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!c) return;
    setForm({...c, tags: c.tags.join(', '), aliases: c.aliases.join(', ')});
    if (!c.outfits.some(o => o.id === outfitId)) {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(`outfit:${id}`)); } catch { /* storage unavailable: fall back to the first outfit */ }
      setOutfitId(saved === 'none' ? null : c.outfits.some(o => o.id === saved) ? saved : c.outfits[0]?.id ?? null);
    }
  }, [c]);
  // Only after the character has loaded, so the initial empty state never overwrites the remembered outfit.
  useEffect(() => { if (c) try { localStorage.setItem(`outfit:${id}`, JSON.stringify(outfitId ?? 'none')); } catch { /* per-browser convenience only */ } }, [id, outfitId]);
  if (!c || !form) return null;
  const set = (k, v) => setForm({...form, [k]: v});
  const save = async () => {
    const list = v => v.split(',').map(t => t.trim()).filter(Boolean);
    await api.put(`/api/characters/${id}`, {...form, tags: list(form.tags), aliases: list(form.aliases)});
    setMsg('Saved'); reload();
  };
  const merge = async into => {
    if (into && confirm(`Merge ${c.name} into ${chars.find(x => x.id === into).name}? Its images and outfits move there.`)) {
      await api.post(`/api/characters/${id}/merge`, {into}); back();
    }
  };
  const remove = async images => { await api.del(`/api/characters/${id}${images ? '?images=true' : ''}`); back(); };
  const upload = async files => {
    const fd = new FormData();
    [...files].forEach(f => fd.append('files', f));
    fd.append('character_id', id);
    if (outfitId) fd.append('outfit_id', outfitId);
    await api.post('/api/assets/upload', fd);
    reloadAssets();
  };
  const field = (k, rows) => <label>{k}{rows ? <textarea rows={rows} value={form[k]} onChange={e => set(k, e.target.value)} /> : <input value={form[k]} onChange={e => set(k, e.target.value)} />}</label>;
  return (
    <>
      <div className="row"><button onClick={back}>← Library</button><h2>{c.name}</h2><button onClick={save}>Save</button><button className="danger" onClick={() => setDeleting(true)}>Delete character</button>
        <select value="" onChange={e => merge(+e.target.value)}><option value="">Merge into…</option>
          {chars?.filter(x => x.id !== id).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select><span className="muted">{msg}</span></div>
      {deleting && (
        <div className="card confirm">
          <b>Delete {c.name}?</b> The character, its outfits and its settings are removed. This cannot be undone.
          <div className="row">
            <button onClick={() => remove(false)}>Delete, keep its images (unassigned)</button>
            <button className="danger" onClick={() => confirm(`Also move all ${chars?.find(x => x.id === id)?.asset_count ?? ''} of ${c.name}'s images to the Trash?`) && remove(true)}>Delete and trash its images</button>
            <button onClick={() => setDeleting(false)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="cols">
        <section className="card">
          <div className="form">{field('name')}{field('trigger')}{field('aliases')}{field('franchise')}{field('tags')}</div>
          {field('description', 3)}{field('body_details', 2)}{field('nsfw_details', 2)}{field('notes', 2)}
          <details>
            <summary>Part prompts</summary>
            <p className="muted small">Each is used only in views where that part is visible, so specifics go here and the description and outfit stay brief. Footwear comes from the outfit when it has one.</p>
            {Object.entries(PART_FIELDS).map(([k, label]) => {
              let v = '';
              try { v = JSON.parse(form.state_json || '{}').part_prompts?.[k] || ''; } catch { /* shown empty */ }
              return <label key={k}>{label}<textarea rows={2} value={v} onChange={e => set('state_json', withParts(form.state_json, p => ({...p, [k]: e.target.value})))} /></label>;
            })}
          </details>
          <Outfits character={c} active={outfitId} setActive={setOutfitId} reload={reload} />
        </section>
        <Generate character={c} outfitId={outfitId} assets={assets || []} onDone={() => { reloadAssets(); }}
          createOutfit={async name => { const r = await api.post('/api/outfits', {character_id: id, name}); await reload(); setOutfitId(r.id); return r.id; }}
          applyDescribed={async (d, outfitTarget) => {
            const next = {...form};
            const {outfit, part_prompts: parts, ...boxes} = d;
            for (const [k, v] of Object.entries(boxes)) next[k === 'prompt' ? 'description' : k] = v;
            // Footwear belongs to the outfit here: sheet_graph lets the outfit's footwear override the part prompt.
            const {footwear, ...rest} = parts || {};
            if (parts) next.state_json = withParts(next.state_json, p => ({...p, ...(outfitTarget ? rest : parts)}));
            setForm(next);
            const patch = {...(outfit && {text: outfit}), ...(footwear && outfitTarget && {footwear})};
            if (outfitTarget && Object.keys(patch).length) { await api.put(`/api/outfits/${outfitTarget}`, patch); reload(); }
            setMsg(Object.keys(patch).length ? 'Described; outfit saved: review the text, then Save' : 'Described: review the text, then Save');
          }} />
      </div>
      <div className="row">
        <h3>Images</h3>
        <select value={kind} onChange={e => setKind(e.target.value)}>
          <option value="">All</option>{['source', 'import', 'view', 'edit', 'list_image', 'sheet', 'template'].map(k => <option key={k}>{k}</option>)}
        </select>
        <select value={style} onChange={e => setStyle(e.target.value)} title="Style the image was generated or restyled in">
          <option value="">Any style</option>{Object.entries(STYLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {usedLoras.length > 0 && <select value={lora} onChange={e => setLora(e.target.value)} title="LoRA used to generate the image">
          <option value="">Any LoRA</option>{usedLoras.map(l => <option key={l} value={l}>{l.split(/[\\/]/).pop()}</option>)}
        </select>}
        <label className="button">Add source images<input type="file" multiple accept="image/*" hidden onChange={e => upload(e.target.files)} /></label>
      </div>
      <AssetGrid assets={assets} onOpen={a => setOpen(a.id)} />
      {more && <button onClick={() => loadAssets(assets.length)}>Load more</button>}
      {open && <AssetDrawer id={open} ids={assets.map(a => a.id)} onNavigate={setOpen} onClose={() => setOpen(null)} onChange={reloadAssets} />}
    </>
  );
}

function Outfits({character, active, setActive, reload}) {
  const outfit = character.outfits.find(o => o.id === active);
  const [o, setO] = useState(outfit);
  useEffect(() => setO(outfit), [outfit]);
  const add = async base => {
    const name = prompt('Outfit name', base ? `${base.name} variant` : 'Default');
    if (!name) return;
    const r = await api.post('/api/outfits', {character_id: character.id, name, text: base?.text || '', footwear: base?.footwear || ''});
    await reload(); setActive(r.id);
  };
  return (
    <>
      <div className="row">
        <h3>Outfit</h3>
        <select value={active ?? ''} onChange={e => setActive(e.target.value ? +e.target.value : null)}>
          <option value="">(none / nude)</option>
          {character.outfits.map(x => <option key={x.id} value={x.id}>{x.name}{x.character_id ? '' : ' (shared)'}</option>)}
        </select>
        <button onClick={() => add()}>New</button>
        {o && <button onClick={() => add(o)} title="Copy this outfit and change one thing">Variant</button>}
        {o?.character_id && <button onClick={async () => { await api.put(`/api/outfits/${o.id}`, {character_id: null}); reload(); }} title="Offer this outfit to every character (Wardrobe)">Share</button>}
        {o && !o.character_id && <button onClick={async () => { const r = await api.post(`/api/outfits/${o.id}/copy`, {character_id: character.id}); await reload(); setActive(r.id); }}
          title="Make a copy that belongs to this character, to change it without affecting others">Copy to {character.name}</button>}
        {o?.character_id && <button onClick={async () => { await api.del(`/api/outfits/${o.id}`); reload(); }}>Delete</button>}
      </div>
      {o && !o.character_id && <p className="muted small">Shared outfit: saving changes it for every character. Manage shared outfits in the Wardrobe.</p>}
      {o && <>
        <label>name<input value={o.name} onChange={e => setO({...o, name: e.target.value})} /></label>
        <label>outfit<textarea rows={3} value={o.text} onChange={e => setO({...o, text: e.target.value})} /></label>
        <label>footwear (designer part prompt, only on views showing feet)<input value={o.footwear} onChange={e => setO({...o, footwear: e.target.value})} /></label>
        <button onClick={async () => { await api.put(`/api/outfits/${o.id}`, o); reload(); }}>Save outfit</button>
      </>}
    </>
  );
}

const SLOTS = {character_image: 'Character image (identity)', detail_image: 'Detail image', pose_image: 'Pose sheet (Muse 5-panel mannequin or template)', describe_image: 'Describe from'};

function Generate({character, outfitId, assets, onDone, applyDescribed, createOutfit}) {
  const [servers] = useLoad(() => api.get('/api/servers'), []);
  const [serverId, setServerId] = useState(null);
  const [lists, setLists] = useState([]);
  const [loraList, setLoraList] = useState([]);
  const [p, setP] = useState({mode: 'per_view', views: VIEW_PRESETS['Muse template · 5'], style: JSON.parse(character.state_json || '{}').style || 'none', seed: 0, megapixels: 1.0, pose_megapixels: 0.75, remove_background: true, prompt_list: '', refs: {}, loras: [], accessories: []});
  const [control, setControl] = useState(EMPTY_CONTROL);
  const [cards, setCards] = useState({});
  const [busy, setBusy] = useState('');
  const [edit, setEdit] = useState({});
  const [picking, setPicking] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [notice, setNotice] = useState('');
  // A custom prompt is the full text, outfit included: a different outfit makes every saved prompt wrong.
  const lastOutfit = useRef(outfitId);
  useEffect(() => {
    if (lastOutfit.current !== outfitId && Object.keys(control.prompts).length) {
      setControl(c => ({...c, prompts: {}}));
      setDrafts({});
      setNotice('Outfit changed: custom prompts cleared, views use the designer prompt again.');
    }
    lastOutfit.current = outfitId;
  }, [outfitId]);
  useEffect(() => { if (servers && !serverId) setServerId(servers[0]?.id); }, [servers]);
  useEffect(() => {
    if (serverId) api.get(`/api/servers/${serverId}/info`).then(i => { setLists(i.prompt_lists || []); setLoraList(i.loras || []); if (!p.prompt_list && i.prompt_lists?.length) set('prompt_list', i.prompt_lists[0]); });
  }, [serverId]);
  // Restore the last per-view session (cards + confirms/seeds/edits) from this character's job history.
  useEffect(() => {
    api.get('/api/jobs', {character_id: character.id}).then(jobs => {
      const last = jobs.find(j => j.kind === 'sheet' && j.status === 'done' && j.params.mode === 'per_view');
      if (!last) return;
      setControl({...EMPTY_CONTROL, ...last.params.control, action: undefined});
      setCards(last.result.views || {});
      setP(x => ({...x, views: last.params.views || x.views, refs: last.params.refs || {}, seed: last.params.seed ?? 0, style: last.params.style || x.style, loras: last.params.loras || [], accessories: last.params.accessories || []}));
    });
  }, [character.id]);
  const set = (k, v) => setP(x => ({...x, [k]: v}));
  const [refs, setRefs] = useState([]);
  useEffect(() => { api.get('/api/assets', {character_id: character.id, kind: 'source,template,view', limit: 1000}).then(setRefs); }, [character.id, assets]);

  const run = async (action, extra = {}) => {
    const ctl = extra.control || control;
    const params = {...p, ...extra.params, control: {...ctl, action}, parents: extra.parents || {}};
    setBusy(action?.type || params.mode);
    try {
      const target = extra.outfitId ?? outfitId;
      const {id} = await api.post('/api/jobs', {kind: 'sheet', server_id: serverId, character_id: character.id, outfit_id: target, params});
      const job = await waitJob(id);
      if (params.describe?.length) await applyDescribed(job.result.described, target);
      else if (params.mode === 'per_view') setCards(job.result.views);
      onDone();
      setBusy('');
    } catch (e) { setBusy(`Error: ${e.message}`); }
  };
  const update = (fn, action) => { const next = structuredClone(control); fn(next); setControl(next); if (action) run(action, {control: next}); return next; };
  const toggleLock = v => update(c => { c.locked = c.locked.includes(v) ? c.locked.filter(x => x !== v) : [...c.locked, v]; });
  const reroll = v => {
    const seed = Math.floor(Math.random() * 2 ** 31);
    update(c => { if (c.edits[v]) c.edit_seeds[v] = seed; else c.seeds[v] = seed; }, {type: 'view', view: v});
  };
  const applyEdit = v => {
    const next = update(c => { if (edit[v]?.trim()) c.edits[v] = edit[v].trim(); else delete c.edits[v]; });
    run({type: 'view', view: v}, {control: next, parents: cards[v] ? {[v]: cards[v].asset_id} : {}});
  };
  // Describe one box from the 'Describe from' image (falls back to the character image); only that box changes.
  const describeImage = p.refs.describe_image || p.refs.character_image;
  const describe = async field => {
    let outfitTarget;
    if ((field === 'outfit' || field === 'all') && !outfitId) {
      const name = prompt('Name for the new outfit', 'New outfit');
      if (!name) return;
      outfitTarget = await createOutfit(name);
    }
    run(null, {params: {describe: field === 'all' ? Object.values(DESCRIBE) : [DESCRIBE[field]], refs: {character_image: describeImage}}, outfitId: outfitTarget});
  };
  const setRef = (slot, aid) => set('refs', {...p.refs, [slot]: aid ?? undefined});
  const slot = s => (
    <div key={s} className="refslot">
      <span className="small muted">{SLOTS[s]}</span>
      {p.refs[s] ? <img src={thumb({id: p.refs[s]})} alt="" onClick={() => setPicking(s)} /> : <div className="ph" onClick={() => setPicking(s)}>{s === 'describe_image' && p.refs.character_image ? 'uses character image' : 'none'}</div>}
      <div className="row"><button onClick={() => setPicking(s)}>Pick…</button>{p.refs[s] && <button onClick={() => setRef(s, null)}>Clear</button>}</div>
    </div>
  );
  const busyRun = busy && !busy.startsWith('Error');
  return (
    <section className="card">
      <h3>Generate</h3>
      <div className="form">
        <label>server<select value={serverId ?? ''} onChange={e => setServerId(+e.target.value)}>{servers?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>mode<select value={p.mode} onChange={e => set('mode', e.target.value)}>{['per_view', 'prompt_list', 'single_canvas'].map(m => <option key={m}>{m}</option>)}</select></label>
        <label title="Designer style, added to every view's prompt">style<select value={p.style} onChange={e => set('style', e.target.value)}>
          {Object.entries(STYLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label title="Base seed. Changing it clears the per-view seeds of unconfirmed views so they follow it">seed<input type="number" value={p.seed} onChange={e => {
          set('seed', +e.target.value);
          update(c => { for (const v of Object.keys(c.seeds)) if (!c.locked.includes(v)) { delete c.seeds[v]; delete c.edit_seeds[v]; } });
        }} /></label>
        <label>megapixels (output)<input type="number" step="0.05" value={p.megapixels} onChange={e => set('megapixels', +e.target.value)} /></label>
        <label title="Encode size of the pose sheet reference; the character and detail references stay at 1 MP">pose MP<input type="number" step="0.05" min="0.1" value={p.pose_megapixels ?? 0.75} onChange={e => set('pose_megapixels', +e.target.value)} /></label>
        <label><span><input type="checkbox" checked={p.remove_background} onChange={e => set('remove_background', e.target.checked)} /> remove background</span></label>
      </div>
      <div className="refslots">{Object.keys(SLOTS).map(slot)}</div>
      <LoraRows serverId={serverId} available={loraList} rows={p.loras || []} onChange={rows => set('loras', rows)} />
      <div className="row">
        <span className="muted small" title="Each joins the designer part prompt for where it is worn, so it only shows on views where that part is visible">Accessories:</span>
        {character.accessories.map(a => {
          const on = p.accessories?.includes(a.id);
          return <button key={a.id} className={on ? 'on' : ''} title={`${PARTS[a.part]}: ${a.text}`}
            onClick={() => set('accessories', on ? p.accessories.filter(x => x !== a.id) : [...(p.accessories || []), a.id])}>{a.name}{a.character_id ? '' : ' (shared)'}</button>;
        })}
        {!character.accessories.length && <span className="muted small">none yet: add weapons, jewelry and props in the Wardrobe</span>}
      </div>
      {p.refs.character_image && p.refs.detail_image && p.refs.pose_image && p.megapixels >= 1 && (p.pose_megapixels ?? 0.75) >= 1 &&
        <p className="err small">Three references with a {p.megapixels} MP output can run out of memory on a 24 GB GPU with Klein 9B. Lower pose MP (e.g. 0.75) or the output megapixels.</p>}
      <div className="row">
        <span className="muted small">LC Vision, from “Describe from”:</span>
        <button disabled={busyRun || !describeImage} onClick={() => describe('prompt')} title="Replace the character description">🔍 Describe character</button>
        <button disabled={busyRun || !describeImage} onClick={() => describe('body_details')} title="Replace body details">🔍 Describe body</button>
        <button disabled={busyRun || !describeImage} onClick={() => describe('outfit')} title="Fill the selected outfit (or a new one); description and body are untouched">🔍 Describe outfit</button>
        <button disabled={busyRun || !describeImage} onClick={() => describe('parts')} title="Fill the part prompts (hair, face, upper, back, lower, hands, other; footwear goes to the selected outfit). Parts hidden in the image keep their text">🔍 Describe parts</button>
        <button disabled={busyRun || !describeImage} onClick={() => describe('all')} title="Brief description, body and outfit, with the specifics in the part prompts">🔍 Describe all (split)</button>
      </div>
      {picking && <Picker character={character} sources={refs} title={SLOTS[picking]} initialTab={picking === 'pose_image' ? 'templates' : 'sources'} onPick={a => { setRef(picking, a.id); setPicking(null); }} onClose={() => setPicking(null)} />}
      {p.mode === 'prompt_list' ? (
        <div className="row">
          <select value={p.prompt_list} onChange={e => set('prompt_list', e.target.value)}>{lists.map(l => <option key={l}>{l}</option>)}</select>
          <button disabled={busyRun} onClick={() => run(null)}>▶ Prompt list</button>
        </div>
      ) : <>
        <div className="row">
          <select value="" onChange={e => e.target.value && set('views', VIEW_PRESETS[e.target.value])}>
            <option value="">View preset…</option>{Object.keys(VIEW_PRESETS).map(k => <option key={k}>{k}</option>)}
          </select>
          <details><summary>{p.views.length} views</summary>
            {Object.entries(VIEWS).map(([v, name]) => <label key={v} className="inline"><input type="checkbox" checked={p.views.includes(v)}
              onChange={e => set('views', e.target.checked ? Object.keys(VIEWS).filter(x => x === v || p.views.includes(x)) : p.views.filter(x => x !== v))} />{name}</label>)}
          </details>
        </div>
        <div className="row">
          {p.mode === 'per_view' && <button disabled={busyRun} onClick={() => run({type: 'next'})}>▶ Next view</button>}
          <button disabled={busyRun} onClick={() => run(p.mode === 'per_view' ? {type: 'all'} : null)}>▶▶ {p.mode === 'per_view' ? 'All views' : 'Render sheet'}</button>
          {p.mode === 'per_view' && <button disabled={busyRun} onClick={() => run({type: 'build'})}>Build final sheet</button>}
        </div>
      </>}
      <p className={busy.startsWith('Error') ? 'err' : 'muted'}>{busy ? (busy.startsWith('Error') ? busy : `Running ${busy}…`) : notice}</p>
      {p.mode === 'per_view' && (
        <div className="cards">
          {p.views.map(v => {
            const card = cards[v];
            const locked = control.locked.includes(v);
            return (
              <div key={v} className={`vcard ${locked ? 'locked' : ''}`}>
                <b>{VIEWS[v]}{card?.stale ? ' •' : ''} {control.prompts[v] && <span className="tag" title="This view sends your saved prompt text instead of the designer prompt">custom prompt</span>}</b>
                {card?.asset_id ? <img src={img({id: card.asset_id})} alt="" /> : <div className="ph">no render</div>}
                <label className="inline small">seed<input type="number" className="seed" value={control.seeds[v] ?? ''} placeholder={card ? `auto (last ${card.seed})` : 'auto'}
                  onChange={e => update(c => { if (e.target.value === '') delete c.seeds[v]; else c.seeds[v] = +e.target.value; })} /></label>
                <div className="row">
                  <button onClick={() => toggleLock(v)}>{locked ? 'Unconfirm' : 'Confirm'}</button>
                  <button disabled={busyRun || locked} onClick={() => card ? reroll(v) : run({type: 'view', view: v})}>{card ? 'New seed' : 'Render'}</button>
                </div>
                <input placeholder={control.edits[v] || 'Edit, e.g. make her smile'} value={edit[v] ?? ''} onChange={e => setEdit({...edit, [v]: e.target.value})}
                  onKeyDown={e => e.key === 'Enter' && applyEdit(v)} />
                <details><summary>Prompt</summary>
                  <textarea rows={6} className="mono small" value={drafts[v] ?? control.prompts[v] ?? card?.prompt ?? ''} onChange={e => setDrafts({...drafts, [v]: e.target.value})} />
                  <button disabled={busyRun || locked} onClick={() => {
                    const text = drafts[v]?.trim();
                    const next = update(c => { if (text && text !== (c.prompts[v] ?? card?.prompt)) c.prompts[v] = text; });
                    setDrafts(d => { const n = {...d}; delete n[v]; return n; });
                    run({type: 'view', view: v}, {control: next});
                  }}>Apply prompt</button>
                  <button disabled={busyRun || locked || !control.prompts[v]} onClick={() => {
                    setDrafts(d => { const n = {...d}; delete n[v]; return n; });
                    update(c => { delete c.prompts[v]; }, {type: 'view', view: v});
                  }}>Reset to designer prompt</button>
                </details>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Picker({character, sources, title, initialTab, onPick, onClose}) {
  const [tab, setTab] = useState(initialTab || 'sources');
  const [lists, setLists] = useState({});
  useEffect(() => {
    if (tab === 'sources' || lists[tab]) return;
    // Templates are shared across characters (pose sheets, built templates).
    (tab === 'templates' ? api.get('/api/assets', {kind: 'template', limit: 500}) : api.get('/api/assets', {character_id: character.id, limit: 1000}))
      .then(a => setLists(l => ({...l, [tab]: a})));
  }, [tab]);
  return (
    <div className="modal" onClick={onClose}>
      <div className="card" onClick={e => e.stopPropagation()}>
        <div className="row">
          <b>Pick: {title}</b>
          <button className={tab === 'sources' ? 'on' : ''} onClick={() => setTab('sources')}>Sources ({sources.length})</button>
          <button className={tab === 'templates' ? 'on' : ''} onClick={() => setTab('templates')}>Templates</button>
          <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All {character.name} images</button>
          <button onClick={onClose}>Close</button>
        </div>
        <AssetGrid assets={tab === 'sources' ? sources : lists[tab]} onOpen={onPick} />
      </div>
    </div>
  );
}
