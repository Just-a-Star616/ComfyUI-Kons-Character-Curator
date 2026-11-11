import {useEffect, useMemo, useState} from 'react';
import {api} from './api.js';

const split = name => name.split(/[\\/]/);
const norm = name => name.replace(/\\/g, '/');
let lastFolder = [];  // The picker reopens in the folder last browsed, with the last base-model filter.
let lastBase = '';
// ComfyUI-Lora-Manager indexes from every server, merged: the servers share the LoRA folder, but each index may miss files.
let catalogs = null;
const loadCatalog = serverId => (catalogs ??= api.get('/api/servers').then(ss => Promise.all(ss.map(s => api.get(`/api/servers/${s.id}/lora_catalog`).then(c => [s.id, c])))))
  .then(list => Object.assign({}, ...list.filter(([id]) => id !== serverId).map(([, c]) => c), ...list.filter(([id]) => id === serverId).map(([, c]) => c)));

// LoRA rows for a generation: {on, lora, strength, words}. words are prepended to the character description.
export function LoraRows({serverId, available, rows, onChange}) {
  const [picking, setPicking] = useState(null);
  const [info, setInfo] = useState(null);
  const [catalog, setCatalog] = useState({});
  useEffect(() => { if (serverId) loadCatalog(serverId).then(setCatalog); }, [serverId]);
  const set = (i, patch) => onChange(rows.map((r, n) => n === i ? {...r, ...patch} : r));
  // Same file, other server's path separator (the remote is Windows): switch the row to this server's spelling.
  useEffect(() => {
    const byNorm = new Map(available.map(n => [norm(n), n]));
    if (rows.some(r => r.lora && !available.includes(r.lora) && byNorm.has(norm(r.lora))))
      onChange(rows.map(r => ({...r, lora: byNorm.get(norm(r.lora)) || r.lora})));
  }, [available]);
  const has = new Set(available);
  return (
    <div className="loras">
      {rows.map((r, i) => {
        const meta = catalog[norm(r.lora)];
        return (
          <div key={i} className="row">
            <input type="checkbox" checked={r.on} onChange={e => set(i, {on: e.target.checked})} title="Use this LoRA" />
            <button className="loraname" onClick={() => setPicking(i)} title={r.lora}>{r.lora ? split(r.lora).pop().replace(/\.safetensors$/, '') : 'Pick a LoRA…'}</button>
            {meta && <span className="tag" title="Base model (LoRA Manager)">{meta.base}</span>}
            <input type="number" step="0.05" style={{width: 64}} value={r.strength} onChange={e => set(i, {strength: +e.target.value})} title="Strength (model and clip)" />
            <input placeholder="trigger words, added to the prompt" value={r.words || ''} onChange={e => set(i, {words: e.target.value})} />
            <button disabled={!r.lora} onClick={() => setInfo(i)}>Info</button>
            <button onClick={() => onChange(rows.filter((_, n) => n !== i))}>✕</button>
            {r.lora && available.length > 0 && !has.has(r.lora) && <span className="err small">not on this server</span>}
          </div>
        );
      })}
      <button onClick={() => onChange([...rows, {on: true, lora: '', strength: 1.0, words: ''}])}>+ LoRA</button>
      {picking != null && <LoraPicker list={available} catalog={catalog} current={rows[picking]?.lora} onClose={() => setPicking(null)}
        onPick={lora => { set(picking, {lora}); setPicking(null); }} />}
      {info != null && <LoraInfo serverId={serverId} lora={rows[info].lora} meta={catalog[norm(rows[info].lora)]} onClose={() => setInfo(null)}
        onWord={w => set(info, {words: rows[info].words?.trim() ? `${rows[info].words.trim()}, ${w}` : w})} onStrength={v => set(info, {strength: v})} />}
    </div>
  );
}

// Folder drill-down with search, after LC LoRA Loader's picker, plus LoRA Manager's base model and preview per file.
// A search or base-model filter lists matches from every folder.
function LoraPicker({list, catalog, current, onPick, onClose}) {
  const [path, setPath] = useState(current ? split(current).slice(0, -1) : lastFolder);
  const [q, setQ] = useState('');
  const [base, setBase] = useState(lastBase);
  useEffect(() => { lastFolder = path; lastBase = base; }, [path, base]);
  const meta = name => catalog[norm(name)];
  const bases = useMemo(() => {
    const count = {};
    for (const n of list) { const b = meta(n)?.base || 'Unknown'; count[b] = (count[b] || 0) + 1; }
    return Object.entries(count).sort((a, b) => a[0].localeCompare(b[0]));
  }, [list, catalog]);
  const level = useMemo(() => {
    const depth = path.length, folders = new Set(), files = [];
    for (const name of list) {
      const parts = split(name);
      if (parts.length <= depth || path.some((seg, i) => parts[i] !== seg)) continue;
      if (parts.length === depth + 1) files.push(name); else folders.add(parts[depth]);
    }
    return {folders: [...folders].sort((a, b) => a.localeCompare(b)), files};
  }, [list, path]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = q || base ? list.filter(n => {
    const m = meta(n);
    const text = `${n} ${m?.title || ''} ${m?.tags?.join(' ') || ''}`.toLowerCase();
    return (!base || (m?.base || 'Unknown') === base) && words.every(w => text.includes(w));
  }).slice(0, 300) : null;
  const file = name => {
    const m = meta(name);
    return (
      <li key={name} className={`lorafile ${name === current ? 'on' : ''}`} onClick={() => onPick(name)} title={name}>
        {m?.preview ? (/\.(mp4|webm)/i.test(m.preview) ? <video src={m.preview} muted /> : <img src={m.preview} alt="" loading="lazy" />) : <span className="noimg" />}
        <span>{hits ? norm(name) : split(name).pop()}{m?.title && <><br /><span className="muted small">{m.title}</span></>}</span>
        {m && <span className="tag">{m.base}</span>}
      </li>
    );
  };
  return (
    <div className="modal" onClick={onClose}>
      <div className="card lorapicker" onClick={e => e.stopPropagation()}>
        <div className="row">
          <b>Pick a LoRA</b>
          <input autoFocus placeholder="Search name, title, tags…" value={q} onChange={e => setQ(e.target.value)} />
          <select value={base} onChange={e => setBase(e.target.value)} title="Base model, from LoRA Manager">
            <option value="">Any base model</option>{bases.map(([b, n]) => <option key={b} value={b}>{b} ({n})</option>)}
          </select>
          <button onClick={onClose}>Close</button>
        </div>
        {!list.length && <p className="muted">This server reports no LoRAs.</p>}
        {!hits && <div className="row crumbs">
          <button onClick={() => setPath([])}>loras</button>
          {path.map((seg, i) => <span key={i}>/ <button onClick={() => setPath(path.slice(0, i + 1))}>{seg}</button></span>)}
        </div>}
        <ul className="lorafiles">
          {hits ? hits.map(file) : <>
            {level.folders.map(f => <li key={f} className="folder" onClick={() => setPath([...path, f])}>📁 {f}</li>)}
            {level.files.map(file)}
          </>}
        </ul>
      </div>
    </div>
  );
}

// rgthree's model info, laid out like its Power Lora Loader info dialog. Name, strengths and notes save into rgthree's info file.
function LoraInfo({serverId, lora, meta, onWord, onStrength, onClose}) {
  const [info, setInfo] = useState(null);
  const [msg, setMsg] = useState('Loading…');
  const load = refresh => {
    setMsg(refresh ? 'Looking up on Civitai…' : 'Loading…');
    api.get(`/api/servers/${serverId}/lora_info`, {file: lora, refresh: refresh || ''}).then(i => { setInfo(i); setMsg(''); }).catch(e => setMsg(`Error: ${e.message}`));
  };
  useEffect(() => load(false), [lora]);
  const save = async (field, value) => {
    await api.post(`/api/servers/${info.server_id}/lora_info`, {file: info.file, fields: {[field]: value}});
    setInfo({...info, [field]: value});
  };
  const civitai = info?.links?.find(l => l.includes('civitai.com/models/'));
  const row = (label, value, help) => value || value === 0 ? <tr><th title={help}>{label}</th><td>{value}</td></tr> : null;
  return (
    <div className="modal" onClick={onClose}>
      <div className="card lorainfo" onClick={e => e.stopPropagation()}>
        <div className="row">
          <h3>{info?.name || meta?.title || split(lora).pop()}</h3>
          {info?.type && <span className="tag lora">{info.type}</span>}
          {(info?.baseModel || meta?.base) && <span className="tag">{info?.baseModel || meta.base}</span>}
          <span className={msg.startsWith('Error') ? 'err' : 'muted'}>{msg}</span>
        </div>
        {info && <table className="infotable"><tbody>
          {row('File', <span className="mono">{info.file}</span>)}
          {row('Hash (sha256)', <span className="mono small">{info.sha256}</span>)}
          <tr><th>Civitai</th><td>{civitai ? <a href={civitai} target="_blank" rel="noreferrer">View on Civitai</a> : <span className="muted">not looked up</span>}
            {' '}<button className="small" onClick={() => load(true)} title="Fetch name, trigger words and example images by file hash, through a server marked 'can reach Civitai'">{civitai ? 'Refresh' : 'Fetch info from Civitai'}</button></td></tr>
          <EditRow label="Name" help="The name for display" value={info.name} onSave={v => save('name', v)} />
          {row('Base Model', [info.baseModel, info.baseModelFile && `(${info.baseModelFile})`].filter(Boolean).join(' '))}
          {info.trainedWords?.length > 0 && <tr><th title="From the file's training metadata and/or Civitai. Click to add to this LoRA's trigger words">Trained Words</th><td>
            <div className="words">{info.trainedWords.map(w => (
              <button key={w.word} className="word" onClick={() => onWord(w.word)} title="Add to trigger words">
                {w.word}{w.civitai && <span className="civ">C</span>}{w.count && <span className="count">{w.count}</span>}
              </button>))}</div></td></tr>}
          {info.clipSkip && info.clipSkip !== 'None' && row('Clip Skip', info.clipSkip)}
          <EditRow label="Strength Min" help="Recommended minimum strength" value={info.strengthMin} onSave={v => save('strengthMin', v === '' ? null : +v)}
            extra={info.strengthMin != null && <button className="small" onClick={() => onStrength(info.strengthMin)}>use</button>} />
          <EditRow label="Strength Max" help="Recommended maximum strength" value={info.strengthMax} onSave={v => save('strengthMax', v === '' ? null : +v)}
            extra={info.strengthMax != null && <button className="small" onClick={() => onStrength(info.strengthMax)}>use</button>} />
          <EditRow label="Additional Notes" value={info.userNote} multiline onSave={v => save('userNote', v)} />
          {meta?.tags?.length > 0 && row('Tags (LoRA Manager)', meta.tags.map(t => <span key={t} className="tag">{t}</span>))}
        </tbody></table>}
        <ul className="loraimages">{info?.images?.map(i => <InfoImage key={i.url} image={i} />)}</ul>
        <div className="row center"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function EditRow({label, help, value, multiline, onSave, extra}) {
  const [draft, setDraft] = useState(null);
  const done = commit => { if (commit && draft !== (value ?? '')) onSave(draft); setDraft(null); };
  const keys = e => { if (e.key === 'Escape') done(false); else if (e.key === 'Enter' && !multiline) done(true); };
  return (
    <tr><th title={help}>{label}</th><td>
      {draft == null ? <div className="editrow"><span>{value ?? ''}</span>{extra}<button className="small" onClick={() => setDraft(String(value ?? ''))} title="Edit">✎</button></div>
        : <div className="editrow">{multiline ? <textarea autoFocus rows={3} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={keys} />
          : <input autoFocus value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={keys} />}
          <button className="small" onClick={() => done(true)}>Save</button></div>}
    </td></tr>
  );
}

// Civitai example images load in the browser, so they need a browser that can reach Civitai (the VPN extension).
function InfoImage({image: i}) {
  const [failed, setFailed] = useState(false);
  if (failed && i.preview) return null;
  const facts = [['seed', i.seed], ['steps', i.steps], ['cfg', i.cfg], ['sampler', i.sampler], ['model', i.model]].filter(([, v]) => v != null);
  return (
    <li><figure>
      {failed ? <div className="blocked">Image didn't load. Civitai needs the VPN in this browser.</div>
        : i.type === 'video' || /\.(mp4|webm)(\?|$)/i.test(i.url) ? <video src={i.url} muted loop autoPlay playsInline onError={() => setFailed(true)} />
        : <a href={i.url} target="_blank" rel="noreferrer"><img src={i.url} alt="" loading="lazy" onError={() => setFailed(true)} /></a>}
      <figcaption>
        {i.preview ? <span className="muted">preview file</span> : i.civitaiUrl && <a href={i.civitaiUrl} target="_blank" rel="noreferrer">civitai ↗</a>}
        {facts.map(([k, v]) => <span key={k}> · {k} {v}</span>)}
        {i.positive && <p className="prompt" title="Click to copy" onClick={() => navigator.clipboard?.writeText(i.positive)}>{i.positive}</p>}
        {i.negative && <p className="prompt muted" title={i.negative}>neg: {i.negative}</p>}
      </figcaption>
    </figure></li>
  );
}
