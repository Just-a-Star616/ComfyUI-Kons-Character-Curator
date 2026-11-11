import {useEffect, useState} from 'react';
import {api, img} from './api.js';
import {label, useLoad} from './ui.jsx';

// Keyboard pass/fail judging over unrated images: P pass, F fail, S or → skip, ← back.
export default function Review() {
  const [chars] = useLoad(() => api.get('/api/characters'), []);
  const [characterId, setCharacterId] = useState('');
  const [queue, setQueue] = useState([]);
  const [i, setI] = useState(0);
  const [source, setSource] = useState(null);
  useEffect(() => {
    api.get('/api/assets', {rating: 'unrated', kind: 'view,edit,list_image', character_id: characterId}).then(a => { setQueue(a.reverse()); setI(0); });
  }, [characterId]);
  const a = queue[i];
  useEffect(() => {
    setSource(null);
    if (a?.character_id) api.get('/api/assets', {character_id: a.character_id, kind: 'source', limit: 1}).then(s => setSource(s[0] || null));
  }, [a?.character_id]);
  useEffect(() => {
    const rate = async rating => { await api.patch(`/api/assets/${a.id}`, {rating}); a.rating = rating; setI(n => n + 1); };
    const onKey = e => {
      if (!a || e.target.tagName === 'INPUT') return;
      if (e.key === 'p') rate('pass');
      else if (e.key === 'f') rate('fail');
      else if (e.key === 's' || e.key === 'ArrowRight') setI(n => n + 1);
      else if (e.key === 'ArrowLeft') setI(n => Math.max(0, n - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [a]);
  return (
    <>
      <div className="row">
        <select value={characterId} onChange={e => setCharacterId(e.target.value)}>
          <option value="">All characters</option>{chars?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <span className="muted">{queue.length ? `${Math.min(i + 1, queue.length)} / ${queue.length}` : 'Nothing to review'} · keys: P pass · F fail · S skip · ← back</span>
      </div>
      {a ? (
        <div className="review">
          {source && <figure><img src={img(source)} alt="" /><figcaption>source</figcaption></figure>}
          <figure className={a.rating || ''}><img src={img(a)} alt="" /><figcaption>{label(a)} · {a.character_name}{a.rating ? ` · ${a.rating}` : ''}</figcaption>
            <p className="mono small">{a.caption || a.prompt}</p></figure>
        </div>
      ) : queue.length > 0 && <p>Done.</p>}
    </>
  );
}
