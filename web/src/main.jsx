import {createRoot} from 'react-dom/client';
import App from './App.jsx';
import {api, CONFIG} from './api.js';
import './style.css';

api.get('/api/config').then(c => {
  Object.assign(CONFIG, c);
  createRoot(document.getElementById('root')).render(<App />);
});
