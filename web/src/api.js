async function call(method, path, body) {
  const init = {method};
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) Object.assign(init, {body: JSON.stringify(body), headers: {'Content-Type': 'application/json'}});
  const r = await fetch(path, init);
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.headers.get('content-type')?.includes('json') ? r.json() : null;
}

// Machine-specific defaults (config.json), filled in main.jsx before the app renders.
export const CONFIG = {};

export const api = {
  get: (path, params) => call('GET', params ? `${path}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null))}` : path),
  post: (path, body) => call('POST', path, body ?? {}),
  put: (path, body) => call('PUT', path, body),
  patch: (path, body) => call('PATCH', path, body),
  del: path => call('DELETE', path),
};

export const img = asset => `/api/assets/${asset.id}/file`;
export const thumb = asset => `/api/assets/${asset.id}/thumb`;

export async function waitJob(id, onTick) {
  for (;;) {
    const job = await api.get(`/api/jobs/${id}`);
    onTick?.(job);
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new Error(job.error);
    await new Promise(r => setTimeout(r, 2000));
  }
}

// From the node's contracts/prompt_contract.v1.json.
// The node's designer styles (contracts/prompt_contract.v1.json).
// Designer part prompts an accessory can join (contracts part_visibility): it shows only where that part is visible.
export const PARTS = {hands: 'Held / hands (full-body views, hand close-ups)', head_hair: 'Head / hair (all views)', face: 'Face (front and side views)',
  upper_clothing: 'Upper body / neck (all views)', back_clothing: 'On the back (back views)', lower_body: 'Hips / legs (full-body views)', footwear: 'Feet (full-body views)'};
export const CATEGORIES = ['weapon', 'jewelry', 'headwear', 'eyewear', 'bag', 'prop', 'other'];

export const STYLES = {none: 'None', anime: 'Anime', semi_realistic_anime: 'Semi-realistic anime', photo: 'Photo', realistic_painting: 'Realistic painting',
  oil_painting: 'Oil painting', watercolor: 'Watercolor', gouache: 'Gouache', colored_pencil: 'Colored pencil', '3d': '3D render'};

export const VIEWS = {
  face_front: 'Front portrait', face_left: 'Profile portrait (faces right)', face_right: 'Profile portrait (faces left)',
  face_3q_left: '3/4 portrait (faces right)', face_3q_right: '3/4 portrait (faces left)', face_back: 'Rear portrait',
  body_front: 'Full body front', body_3q: 'Full body 3/4', body_left: 'Left side (faces right)', body_right: 'Right side (faces left)',
  body_back: 'Full body back', clothing_front: 'Clothing front', clothing_back: 'Clothing back', hands: 'Hands', feet: 'Feet',
};
export const VIEW_PRESETS = {
  'Muse template · 5': ['face_front', 'body_front', 'body_left', 'body_right', 'body_back'],
  'Standard · 5': ['face_front', 'face_left', 'body_front', 'body_left', 'body_back'],
  'Turnaround · 3': ['body_front', 'body_left', 'body_back'],
  'Head · 6': ['face_front', 'face_left', 'face_right', 'face_3q_left', 'face_3q_right', 'face_back'],
  'Clothing · 2': ['clothing_front', 'clothing_back'],
  'Detail · 15': Object.keys(VIEWS),
};
